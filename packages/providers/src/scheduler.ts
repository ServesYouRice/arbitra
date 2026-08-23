export interface RateLimitPolicy { readonly rpm: number; readonly tpm: number; readonly maxConcurrent: number; }
export interface SchedulerClock { now(): number; sleep(milliseconds: number): Promise<void>; }
export interface SchedulerLease { readonly providerId: string; readonly estimatedTokens: number; release(): void; }

interface Admission { readonly at: number; readonly tokens: number; }
interface ProviderState { active: number; blockedUntil: number; admissions: Admission[]; waiters: Set<() => void>; }

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export class RateLimitScheduler {
  private readonly states = new Map<string, ProviderState>();
  constructor(private readonly policies: Readonly<Record<string, RateLimitPolicy>>, private readonly clock: SchedulerClock = systemClock) {
    for (const [providerId, policy] of Object.entries(policies)) validatePolicy(providerId, policy);
  }

  async acquire(providerId: string, estimatedTokens: number): Promise<SchedulerLease> {
    const policy = this.policy(providerId);
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) throw new Error("INVALID_ESTIMATED_TOKENS");
    if (estimatedTokens > policy.tpm) throw new Error(`REQUEST_EXCEEDS_PROVIDER_TPM:${providerId}`);
    const state = this.state(providerId);
    while (true) {
      const now = this.clock.now();
      state.admissions = state.admissions.filter(({ at }) => at > now - 60_000);
      const tokensInWindow = state.admissions.reduce((total, item) => total + item.tokens, 0);
      if (now >= state.blockedUntil && state.active < policy.maxConcurrent
        && state.admissions.length < policy.rpm && tokensInWindow + estimatedTokens <= policy.tpm) {
        state.active += 1;
        state.admissions.push({ at: now, tokens: estimatedTokens });
        let released = false;
        return Object.freeze({ providerId, estimatedTokens, release: () => {
          if (released) return;
          released = true; state.active -= 1; wake(state);
        } });
      }
      const delays: number[] = [];
      if (now < state.blockedUntil) delays.push(state.blockedUntil - now);
      if (state.admissions.length >= policy.rpm || tokensInWindow + estimatedTokens > policy.tpm) {
        const first = state.admissions[0]; if (first !== undefined) delays.push(Math.max(1, first.at + 60_000 - now));
      }
      const waitForRelease = changed(state);
      try {
        if (delays.length === 0) await waitForRelease.promise;
        else await Promise.race([this.clock.sleep(Math.min(...delays)), waitForRelease.promise]);
      } finally { waitForRelease.cancel(); }
    }
  }

  respectRetryAfter(providerId: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("INVALID_RETRY_AFTER");
    const state = this.state(providerId);
    state.blockedUntil = Math.max(state.blockedUntil, this.clock.now() + milliseconds);
    wake(state);
  }

  snapshot(providerId: string): { readonly active: number; readonly requestsInWindow: number; readonly tokensInWindow: number; readonly blockedUntil: number } {
    const state = this.state(providerId); const now = this.clock.now();
    const current = state.admissions.filter(({ at }) => at > now - 60_000);
    return Object.freeze({ active: state.active, requestsInWindow: current.length,
      tokensInWindow: current.reduce((total, item) => total + item.tokens, 0), blockedUntil: state.blockedUntil });
  }

  private policy(providerId: string): RateLimitPolicy {
    const value = this.policies[providerId]; if (value === undefined) throw new Error(`UNKNOWN_PROVIDER_POLICY:${providerId}`); return value;
  }
  private state(providerId: string): ProviderState {
    let value = this.states.get(providerId);
    if (value === undefined) { value = { active: 0, blockedUntil: 0, admissions: [], waiters: new Set() }; this.states.set(providerId, value); }
    return value;
  }
}

function validatePolicy(providerId: string, policy: RateLimitPolicy): void {
  for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`INVALID_RATE_POLICY:${providerId}:${key}`);
}
function changed(state: ProviderState): { readonly promise: Promise<void>; readonly cancel: () => void } {
  let wakeWaiter: () => void = () => {};
  const promise = new Promise<void>((resolve) => { wakeWaiter = resolve; state.waiters.add(resolve); });
  return { promise, cancel: () => state.waiters.delete(wakeWaiter) };
}
function wake(state: ProviderState): void { for (const resolve of state.waiters) resolve(); state.waiters.clear(); }
