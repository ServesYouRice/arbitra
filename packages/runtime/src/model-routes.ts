import { callCostUsd, priceOf, PRICES_AS_OF, type TokenPrice } from "@arbitra/providers/pricing.js";
import { ProviderBudgetSuspendedError, ProviderUsageLimitError } from "@arbitra/providers/runtime.js";
import type { TransportUsage } from "@arbitra/providers/transport-contract.js";
import type { ModelRouteReason } from "@arbitra/core/runner/events.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { DEFAULT_FALLBACK_WAIT_MS, type ProviderExecution } from "@arbitra/schemas/provider-execution.js";
import type { RunStore } from "./run-store.js";

/** The artifact that holds a run's spend by profile and the switches its profiles made. */
export const MODEL_ROUTES_KIND = "model-routes";

/** One switch, as the run records it and as its `model_route_switched` event says it. */
export interface RouteSwitch {
  readonly at: string; readonly from: string; readonly to: string | null; readonly reason: ModelRouteReason;
  readonly spentUsd: number | null; readonly resetsAt?: string; readonly effort?: string; readonly detail?: string;
}

/** Why a profile is out, and until when (ISO-8601; null for the rest of the run, or until its cap is raised). */
interface Out { readonly reason: Exclude<ModelRouteReason, "reset">; readonly until: string | null }

export interface ModelRouteState {
  readonly schemaVersion: 1;
  /** The date of the price table the dollars were counted by (packages/providers/src/pricing.ts). */
  readonly pricesAsOf: string;
  /** Dollars each priced API profile has spent in this run, from its calls' reported usage. */
  readonly spentUsd: Readonly<Record<string, number>>;
  /** Calls of a priced profile whose usage did not say what they read, so their cost is not in `spentUsd`. */
  readonly unpricedCalls: Readonly<Record<string, number>>;
  readonly out: Readonly<Record<string, Out>>;
  readonly switches: readonly RouteSwitch[];
}

const EMPTY: ModelRouteState = Object.freeze({ schemaVersion: 1, pricesAsOf: PRICES_AS_OF, spentUsd: {}, unpricedCalls: {}, out: {}, switches: [] });

/**
 * Which profile a call of a model profile goes to, from what the run has recorded: a profile whose account ran out
 * hands the rest of its work to its fallback (`workflow.modelExecution.fallbacks`), the calls left of a stage already
 * running included, and the run goes on rather than pause. Each switch is recorded in the run (the `model-routes`
 * artifact) and as a `model_route_switched` event, so a resume goes on where the run was. A call is identified by the
 * profile its stage asked for, not by the one that answered it, so a recorded answer matches on resume and in a replay
 * whichever route made it.
 *
 * Observed live (memoria, November 10–11, 2026): Opus through the owner's API key spent nearly its $200 of credit
 * before the plan, and the plan could only run on Opus through Claude Code by a resume made by hand.
 */
export class ModelRoutes {
  #state: ModelRouteState | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #wait: number;

  constructor(private readonly store: RunStore, private readonly config: RunConfig, private readonly execution: ProviderExecution, private readonly now: () => number = Date.now) {
    this.#wait = execution.fallbackWaitMs ?? DEFAULT_FALLBACK_WAIT_MS;
    for (const id of Object.keys(execution.maximumCostUsd ?? {})) if (this.#price(id) === null) throw new Error(`MODEL_COST_CAP_UNPRICED:${id}: no price is known for ${this.config.models[id]?.modelId ?? id}, so its dollar cap could not be kept; add it to packages/providers/src/pricing.ts or remove the cap`);
  }

  /** The profile a call of `requested` goes to now. Throws, so the run pauses, when every profile it could go to is out. */
  route(requested: string, effort?: string): Promise<string> { return this.#serial(() => this.#route(requested, effort)); }

  /**
   * A call on `profile` was refused because its account ran out. Returns the profile the call is sent to instead, or
   * null when the run should pause: a subscription's limit that resets within `fallbackWaitMs`, or no fallback left.
   */
  exhausted(profile: string, error: ProviderUsageLimitError, effort?: string): Promise<string | null> {
    return this.#serial(async () => {
      const state = await this.#load();
      // A call in flight beside the one that switched: it follows the switch.
      if (state.out[profile] !== undefined) { try { return await this.#route(profile, effort); } catch { return null; } }
      const subscription = this.#subscription(profile);
      if (subscription && error.retryAfterMs !== null && error.retryAfterMs <= this.#wait) return null;
      const next = this.execution.fallbacks?.[profile];
      if (next === undefined) return null;
      const resetsAt = subscription && error.retryAfterMs !== null ? new Date(this.now() + error.retryAfterMs).toISOString() : null;
      const reason = subscription ? "usage_limit" : "credit_out";
      const target = await this.#reachable(next, new Set([profile]));
      if (target === null) return null;
      await this.#switch(profile, target, { reason, until: resetsAt }, effort, error.message);
      return target;
    });
  }

  /** Counts what a call answered on `profile` cost, when it is a priced API profile; returns the dollars, or null. */
  charge(profile: string, usage: TransportUsage | null, effort?: string): Promise<number | null> {
    const prices = this.#price(profile);
    if (prices === null) return Promise.resolve(null);
    return this.#serial(async () => {
      const state = await this.#load();
      const cost = callCostUsd(usage, prices);
      const spentUsd = { ...state.spentUsd, [profile]: (state.spentUsd[profile] ?? 0) + (cost ?? 0) };
      const unpricedCalls = cost === null ? { ...state.unpricedCalls, [profile]: (state.unpricedCalls[profile] ?? 0) + 1 } : state.unpricedCalls;
      await this.#save({ ...state, spentUsd, unpricedCalls });
      // The cap is met by this call: the next ones go to the fallback, or the run pauses at the next call.
      if (state.out[profile] === undefined && this.#capReached(profile)) await this.#capOut(profile, effort);
      return cost;
    });
  }

  /** What the run has recorded: its spend and its switches. */
  async state(): Promise<ModelRouteState> { return this.#serial(() => this.#load()); }

  async #route(requested: string, effort?: string): Promise<string> {
    const target = await this.#reachable(requested, new Set(), effort);
    if (target !== null) return target;
    throw this.#paused(requested);
  }

  /**
   * The first profile from `id` along its fallbacks that is not out, or null. A profile back in reach (its limit has
   * reset, or a resume raised its cap) is taken again, and that is recorded. A profile met at its cap is put out here.
   */
  async #reachable(id: string, seen: Set<string>, effort?: string): Promise<string | null> {
    let current = id;
    for (;;) {
      if (seen.has(current)) return null;
      seen.add(current);
      const out = (await this.#load()).out[current];
      if (out === undefined && this.#capReached(current)) await this.#capOut(current, effort);
      const now = (await this.#load()).out[current];
      if (now === undefined) return current;
      const back = now.reason === "usage_limit" && now.until !== null && this.now() >= Date.parse(now.until) || now.reason === "cost_cap" && !this.#capReached(current);
      if (back) {
        await this.#back(current, now.reason === "cost_cap" ? "its dollar cap was raised" : "its usage limit has reset", effort);
        return current;
      }
      const next = this.execution.fallbacks?.[current];
      if (next === undefined) return null;
      current = next;
    }
  }

  /** The profile has met its cap: its work goes to its fallback, or nowhere and the run pauses at its next call. */
  async #capOut(profile: string, effort?: string): Promise<void> {
    const next = this.execution.fallbacks?.[profile];
    const target = next === undefined ? null : await this.#reachable(next, new Set([profile]));
    await this.#switch(profile, target, { reason: "cost_cap", until: null }, effort, `$${(this.execution.maximumCostUsd?.[profile] ?? 0).toFixed(2)} cap`);
  }

  async #switch(from: string, to: string | null, out: Out, effort: string | undefined, detail: string): Promise<void> {
    const state = await this.#load();
    const entry: RouteSwitch = { at: new Date(this.now()).toISOString(), from, to, reason: out.reason, spentUsd: this.#spent(state, from), ...(out.until === null ? {} : { resetsAt: out.until }),
      ...(effort === undefined ? {} : { effort }), detail: detail.slice(0, 300) };
    await this.#save({ ...state, out: { ...state.out, [from]: out }, switches: [...state.switches, entry] });
    await this.store.appendEvent({ t: "model_route_switched", runId: this.store.runId, ...entry }, "expensive");
  }

  async #back(profile: string, detail: string, effort?: string): Promise<void> {
    const state = await this.#load();
    const out = Object.fromEntries(Object.entries(state.out).filter(([id]) => id !== profile));
    const from = [...state.switches].reverse().find((entry) => entry.from === profile)?.to ?? profile;
    const entry: RouteSwitch = { at: new Date(this.now()).toISOString(), from, to: profile, reason: "reset", spentUsd: this.#spent(state, profile), ...(effort === undefined ? {} : { effort }), detail };
    await this.#save({ ...state, out, switches: [...state.switches, entry] });
    await this.store.appendEvent({ t: "model_route_switched", runId: this.store.runId, ...entry }, "expensive");
  }

  #paused(requested: string): Error {
    const state = this.#state ?? EMPTY;
    const chain: string[] = [];
    for (let id: string | undefined = requested; id !== undefined && !chain.includes(id); id = this.execution.fallbacks?.[id]) chain.push(id);
    const capped = chain.find((id) => state.out[id]?.reason === "cost_cap");
    if (capped !== undefined) {
      return new ProviderBudgetSuspendedError(`MODEL_COST_CAP_REACHED:${capped}: ${capped} has spent $${(state.spentUsd[capped] ?? 0).toFixed(2)} of its $${(this.execution.maximumCostUsd?.[capped] ?? 0).toFixed(2)} cap${chain.length > 1 ? ", and the profiles it falls back to are out too" : " and has no fallback"}. The run pauses with its work kept; resume it with a higher cap, or start it again with a fallback.`);
    }
    // Paused as rate limited, with the soonest reset in the words a wake-up reads ("until <ISO time>").
    const resets = chain.flatMap((id) => { const until = state.out[id]?.until; return until === undefined || until === null ? [] : [until]; }).sort();
    const until = resets[0];
    return new ProviderUsageLimitError(`MODEL_ROUTES_EXHAUSTED:${requested}: ${chain.join(", ")} ${chain.length === 1 ? "is" : "are all"} out (${chain.map((id) => `${id}: ${state.out[id]?.reason ?? "unknown"}`).join("; ")})${until === undefined ? "" : `, the first until ${until}`}. The run pauses with its work kept; resume it once one of them can answer again.`, 0,
      until === undefined ? null : Math.max(0, Date.parse(until) - this.now()));
  }

  #capReached(profile: string): boolean {
    const cap = this.execution.maximumCostUsd?.[profile];
    return cap !== undefined && ((this.#state ?? EMPTY).spentUsd[profile] ?? 0) >= cap;
  }

  #spent(state: ModelRouteState, profile: string): number | null { return this.#price(profile) === null ? null : Math.round((state.spentUsd[profile] ?? 0) * 100) / 100; }

  /** The price of a profile's calls: only a profile on an API endpoint is priced. */
  #price(profile: string): TokenPrice | null {
    if (this.#subscription(profile) || this.#endpoint(profile) === undefined) return null;
    const model = this.config.models[profile];
    return model === undefined ? null : priceOf(model.modelId);
  }

  #endpoint(profile: string) { return this.execution.endpoints.find(({ id }) => id === this.execution.modelEndpoints[profile]); }
  #subscription(profile: string): boolean { const endpoint = this.#endpoint(profile); return endpoint !== undefined && "auth" in endpoint; }

  async #load(): Promise<ModelRouteState> {
    if (this.#state !== undefined) return this.#state;
    const artifact = (await this.store.listArtifacts()).find(({ kind }) => kind === MODEL_ROUTES_KIND);
    const stored = artifact === undefined ? null : JSON.parse((await this.store.readArtifact(artifact.artifactId)).content) as Partial<ModelRouteState>;
    this.#state = stored === null ? EMPTY : { ...EMPTY, ...stored, schemaVersion: 1 };
    return this.#state;
  }

  async #save(next: ModelRouteState): Promise<void> {
    this.#state = next;
    await this.store.publish(MODEL_ROUTES_KIND, next);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
