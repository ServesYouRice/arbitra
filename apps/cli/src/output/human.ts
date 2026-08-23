import type { CliJsonOutput } from "./json.js";

export function renderHuman(output: CliJsonOutput): string {
  if (output.command === "estimate" && isEstimateResult(output.result)) {
    const fanOut = output.result.fanOut.map((item) =>
      `  - ${item.stage} / ${item.providerId}: ${formatInteger(item.calls)} call${item.calls === 1 ? "" : "s"}`);
    const uncertainty = output.result.uncertainty.length === 0 ? "none" : output.result.uncertainty.join(", ");
    return [
      `estimate: ${output.policy.gateStatus}`,
      `budget: ${output.result.budgetVerdict}`,
      "fan-out:",
      ...fanOut,
      `tokens: ${formatInteger(output.result.tokens.minimum)}-${formatInteger(output.result.tokens.maximum)}`,
      `cost: ${formatCost(output.result.cost.minimum, output.result.cost.currency)}-${formatCost(output.result.cost.maximum, output.result.cost.currency)}`,
      `uncertainty: ${uncertainty}`,
    ].join("\n");
  }
  const reasons = output.policy.reasons.length === 0 ? "none" : output.policy.reasons.join(", ");
  if (isSecurityConsensusResult(output.result)) {
    const candidates = output.result.suppressionCandidates.flatMap((candidate) => [
      `  - ${candidate.path}; read by: ${formatList(candidate.readBy)}; findings citing: ${formatList(candidate.findingsCiting)}`,
      `    ${candidate.note}`,
    ]);
    const surfaces = output.result.unexaminedSurfaces.map((surface) =>
      `  - [${surface.weight}] ${surface.surfaceId}: ${formatList(surface.paths)}`);
    const coverage = output.result.securityCoverage;
    return [
      `${output.command}: ${output.policy.gateStatus} (reasons: ${reasons})`,
      `security coverage: ${coverage.degraded ? `degraded (${coverage.reason ?? "unspecified"})` : "complete"}`,
      `suppression candidates: ${output.result.suppressionCandidates.length}`,
      ...candidates,
      `unexamined surfaces: ${output.result.unexaminedSurfaces.length}`,
      ...surfaces,
    ].join("\n");
  }
  return `${output.command}: ${output.policy.gateStatus} (reasons: ${reasons})`;
}

interface EstimateResult {
  readonly fanOut: readonly { readonly stage: string; readonly providerId: string; readonly calls: number }[];
  readonly tokens: { readonly minimum: number; readonly maximum: number };
  readonly cost: { readonly minimum: number | null; readonly maximum: number | null; readonly currency: string };
  readonly uncertainty: readonly string[];
  readonly budgetVerdict: string;
}

interface SecurityConsensusResult {
  readonly suppressionCandidates: readonly {
    readonly path: string;
    readonly readBy: readonly string[];
    readonly findingsCiting: readonly string[];
    readonly note: string;
  }[];
  readonly securityCoverage: { readonly degraded: boolean; readonly reason: string | null };
  readonly unexaminedSurfaces: readonly {
    readonly surfaceId: string;
    readonly paths: readonly string[];
    readonly weight: string;
  }[];
}

function isEstimateResult(value: unknown): value is EstimateResult {
  if (!isRecord(value) || !Array.isArray(value["fanOut"]) || !isRecord(value["tokens"])
    || !isRecord(value["cost"]) || !Array.isArray(value["uncertainty"])
    || typeof value["budgetVerdict"] !== "string") return false;
  return value["fanOut"].every((item) => isRecord(item) && typeof item["stage"] === "string"
      && typeof item["providerId"] === "string" && isNonnegativeInteger(item["calls"]))
    && isNonnegativeNumber(value["tokens"]["minimum"])
    && isNonnegativeNumber(value["tokens"]["maximum"])
    && nullableNonnegativeNumber(value["cost"]["minimum"])
    && nullableNonnegativeNumber(value["cost"]["maximum"])
    && typeof value["cost"]["currency"] === "string"
    && value["uncertainty"].every((item) => typeof item === "string");
}

function isSecurityConsensusResult(value: unknown): value is SecurityConsensusResult {
  if (!isRecord(value) || !Array.isArray(value["suppressionCandidates"])
    || !isRecord(value["securityCoverage"]) || !Array.isArray(value["unexaminedSurfaces"])) return false;
  const coverage = value["securityCoverage"];
  return typeof coverage["degraded"] === "boolean"
    && (coverage["reason"] === null || typeof coverage["reason"] === "string")
    && value["suppressionCandidates"].every((candidate) => isRecord(candidate)
      && typeof candidate["path"] === "string" && isStringArray(candidate["readBy"])
      && isStringArray(candidate["findingsCiting"]) && typeof candidate["note"] === "string")
    && value["unexaminedSurfaces"].every((surface) => isRecord(surface)
      && typeof surface["surfaceId"] === "string" && isStringArray(surface["paths"])
      && typeof surface["weight"] === "string");
}

function formatInteger(value: number): string { return new Intl.NumberFormat("en-US").format(value); }
function formatList(values: readonly string[]): string { return values.length === 0 ? "none" : values.join(", "); }
function formatCost(value: number | null, currency: string): string {
  return value === null ? "unknown" : `${currency} ${value.toFixed(6)}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isNonnegativeInteger(value: unknown): value is number { return isNonnegativeNumber(value) && Number.isSafeInteger(value); }
function nullableNonnegativeNumber(value: unknown): value is number | null { return value === null || isNonnegativeNumber(value); }
