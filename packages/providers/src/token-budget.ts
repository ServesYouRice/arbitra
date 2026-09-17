import type { BudgetReservation, InvocationBudget } from "./runtime.js";
import type { TransportUsage } from "./transport-contract.js";

export interface TokenReservation {
  readonly id: string;
  readonly activityId: string;
  readonly estimatedTokens: number;
  readonly usage: TransportUsage | null;
}
export interface TokenBudgetState {
  readonly schemaVersion: 1;
  readonly maximumTokens: number;
  readonly reservations: readonly TokenReservation[];
}
/** Save must atomically commit before resolving. One budget owns a run's backend. */
export interface TokenBudgetBackend {
  load(): Promise<unknown>;
  save(state: TokenBudgetState): Promise<void>;
}

/** Unknown usage stays charged at its admission estimate, including interrupted attempts. */
export class DurableTokenBudget implements InvocationBudget {
  private state: TokenBudgetState | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly maximumTokens: number, private readonly backend: TokenBudgetBackend) {
    positiveInteger(maximumTokens, "INVALID_TOKEN_BUDGET");
  }

  reserve(activityId: string, estimatedTokens: number): Promise<BudgetReservation> {
    return this.serial(async () => {
      if (activityId.trim() === "") throw new Error("INVALID_ACTIVITY_ID");
      positiveInteger(estimatedTokens, "INVALID_TOKEN_RESERVATION");
      const state = await this.load();
      const charged = state.reservations.reduce((sum, item) => sum + charge(item), 0);
      if (estimatedTokens > this.maximumTokens - charged) return { allowed: false, reason: "Run token budget exhausted" };
      const reservationId = `reservation-${state.reservations.length + 1}`;
      await this.commit({ ...state, reservations: [...state.reservations, { id: reservationId, activityId, estimatedTokens, usage: null }] });
      return { allowed: true, reservationId };
    });
  }

  recordActual(activityId: string, usage: TransportUsage, reservationId?: string): Promise<void> {
    return this.serial(async () => {
      validateUsage(usage);
      const state = await this.load();
      const reservation = state.reservations.find(({ id }) => id === reservationId);
      if (reservation === undefined || reservation.activityId !== activityId) throw new Error("UNKNOWN_TOKEN_RESERVATION");
      if (reservation.usage !== null) {
        if (JSON.stringify(reservation.usage) !== JSON.stringify(usage)) throw new Error("TOKEN_USAGE_ALREADY_RECORDED");
        return;
      }
      await this.commit({ ...state, reservations: state.reservations.map((item) => item.id === reservationId ? { ...item, usage: { ...usage } } : item) });
    });
  }

  snapshot(): Promise<TokenBudgetState> { return this.serial(async () => structuredClone(await this.load())); }

  private async load(): Promise<TokenBudgetState> {
    if (this.state !== undefined) return this.state;
    const stored = await this.backend.load();
    if (stored === null) return { schemaVersion: 1, maximumTokens: this.maximumTokens, reservations: [] };
    validateState(stored, this.maximumTokens);
    this.state = structuredClone(stored);
    return this.state;
  }

  private async commit(state: TokenBudgetState): Promise<void> {
    await this.backend.save(structuredClone(state));
    this.state = state;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => undefined);
    return pending;
  }
}

function charge(reservation: TokenReservation): number {
  const usage = reservation.usage;
  // Cache counts are subdivisions of input tokens, not additional usage.
  if (usage === null || usage.inputTokens === null || usage.outputTokens === null) {
    return Math.max(reservation.estimatedTokens, (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
  }
  return usage.inputTokens + usage.outputTokens;
}
function positiveInteger(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(message);
}
function validateUsage(value: TransportUsage): void {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_TOKEN_USAGE");
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) throw new Error("INVALID_TOKEN_USAGE");
  }
}
function validateState(value: unknown, maximumTokens: number): asserts value is TokenBudgetState {
  if (typeof value !== "object" || value === null) throw new Error("INVALID_TOKEN_BUDGET_STATE");
  const state = value as TokenBudgetState;
  if (state.schemaVersion !== 1 || state.maximumTokens !== maximumTokens || !Array.isArray(state.reservations)) throw new Error("INVALID_TOKEN_BUDGET_STATE");
  for (const [index, item] of state.reservations.entries()) {
    if (typeof item !== "object" || item === null || item.id !== `reservation-${index + 1}` || typeof item.activityId !== "string" || item.activityId.trim() === "") throw new Error("INVALID_TOKEN_BUDGET_STATE");
    positiveInteger(item.estimatedTokens, "INVALID_TOKEN_BUDGET_STATE");
    if (item.usage !== null) validateUsage(item.usage);
  }
}
