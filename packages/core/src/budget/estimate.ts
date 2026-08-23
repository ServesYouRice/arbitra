export interface TokenRange { readonly minimum: number; readonly maximum: number; }
export interface CostRange { readonly minimum: number | null; readonly maximum: number | null; readonly currency: "USD"; }
export interface ResolvedCallPlan {
  readonly stage: string;
  readonly providerId: string;
  readonly calls: number;
  readonly inputTokensPerCall: TokenRange;
  readonly outputTokensPerCall: TokenRange;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
}
export interface BudgetCaps { readonly maximumTokens: number | null; readonly maximumCostUsd: number | null; }
export interface ResolvedEstimateConfig {
  readonly calls: readonly ResolvedCallPlan[];
  readonly budget: BudgetCaps;
  readonly allowDownscale: boolean;
}
export interface SnapshotSummary { readonly selectedFiles: number; readonly selectedBytes: number; readonly languageCount: number; }
export interface FanOutEstimate {
  readonly stage: string;
  readonly providerId: string;
  readonly calls: number;
  readonly tokens: TokenRange;
  readonly cost: CostRange;
}
export interface RunEstimate {
  readonly fanOut: readonly FanOutEstimate[];
  readonly tokens: TokenRange;
  readonly cost: CostRange;
  readonly uncertainty: readonly string[];
  readonly assumptions: { readonly selectedFiles: number; readonly selectedBytes: number; readonly languageCount: number };
}

/** The sole conservative estimator used by both display and enforcement. */
export function estimateRun(config: ResolvedEstimateConfig, snapshot: SnapshotSummary): RunEstimate {
  validateSnapshot(snapshot);
  const uncertainty = new Set<string>();
  const fanOut = config.calls.map((plan) => {
    validatePlan(plan);
    const tokens = {
      minimum: plan.calls * (plan.inputTokensPerCall.minimum + plan.outputTokensPerCall.minimum),
      maximum: plan.calls * (plan.inputTokensPerCall.maximum + plan.outputTokensPerCall.maximum),
    };
    let minimumCost: number | null = null;
    let maximumCost: number | null = null;
    if (plan.inputUsdPerMillionTokens === null || plan.outputUsdPerMillionTokens === null) {
      uncertainty.add(`unknown_price:${plan.providerId}`);
    } else {
      minimumCost = plan.calls * (plan.inputTokensPerCall.minimum * plan.inputUsdPerMillionTokens
        + plan.outputTokensPerCall.minimum * plan.outputUsdPerMillionTokens) / 1_000_000;
      maximumCost = plan.calls * (plan.inputTokensPerCall.maximum * plan.inputUsdPerMillionTokens
        + plan.outputTokensPerCall.maximum * plan.outputUsdPerMillionTokens) / 1_000_000;
    }
    if (plan.inputTokensPerCall.minimum !== plan.inputTokensPerCall.maximum
      || plan.outputTokensPerCall.minimum !== plan.outputTokensPerCall.maximum) uncertainty.add(`token_range:${plan.stage}`);
    return Object.freeze({ stage: plan.stage, providerId: plan.providerId, calls: plan.calls,
      tokens: Object.freeze(tokens), cost: Object.freeze({ minimum: roundCost(minimumCost), maximum: roundCost(maximumCost), currency: "USD" as const }) });
  });
  const allPricesKnown = fanOut.every(({ cost }) => cost.minimum !== null && cost.maximum !== null);
  return Object.freeze({
    fanOut: Object.freeze(fanOut),
    tokens: Object.freeze({ minimum: sum(fanOut.map(({ tokens }) => tokens.minimum)), maximum: sum(fanOut.map(({ tokens }) => tokens.maximum)) }),
    cost: Object.freeze({ minimum: allPricesKnown ? roundCost(sum(fanOut.map(({ cost }) => cost.minimum ?? 0))) : null,
      maximum: allPricesKnown ? roundCost(sum(fanOut.map(({ cost }) => cost.maximum ?? 0))) : null, currency: "USD" }),
    uncertainty: Object.freeze([...uncertainty].sort()),
    assumptions: Object.freeze({ ...snapshot }),
  });
}

function validatePlan(plan: ResolvedCallPlan): void {
  if (!Number.isSafeInteger(plan.calls) || plan.calls < 0) throw new Error(`INVALID_ESTIMATE_CALLS:${plan.stage}`);
  validateRange(plan.inputTokensPerCall, `${plan.stage}:input`); validateRange(plan.outputTokensPerCall, `${plan.stage}:output`);
  for (const price of [plan.inputUsdPerMillionTokens, plan.outputUsdPerMillionTokens]) if (price !== null && (!Number.isFinite(price) || price < 0)) throw new Error(`INVALID_ESTIMATE_PRICE:${plan.providerId}`);
}
function validateRange(range: TokenRange, label: string): void {
  if (!Number.isSafeInteger(range.minimum) || !Number.isSafeInteger(range.maximum) || range.minimum < 0 || range.maximum < range.minimum) throw new Error(`INVALID_TOKEN_RANGE:${label}`);
}
function validateSnapshot(value: SnapshotSummary): void {
  for (const [key, item] of Object.entries(value)) if (!Number.isSafeInteger(item) || item < 0) throw new Error(`INVALID_SNAPSHOT_SUMMARY:${key}`);
}
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function roundCost(value: number | null): number | null { return value === null ? null : Math.round(value * 1_000_000) / 1_000_000; }
