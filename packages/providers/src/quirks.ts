export interface SamplingDefaults {
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly topK: number | null;
}

export interface ProviderQuirks {
  readonly systemPromptSupport: "full" | "discouraged" | "none";
  readonly fewShotPolicy: "helps" | "neutral" | "harmful";
  readonly promptStyle: "xml" | "markdown" | "plain";
  readonly documentPlacement: "leading" | "trailing";
  readonly historyPolicy: "strip_reasoning" | "round_trip_opaque" | "verbatim";
  readonly samplingDefaults: SamplingDefaults;
  readonly greedyDecodingSafe: boolean;
  readonly toolLoopLimit: number;
  readonly prefillSupported: boolean;
}

export function parseProviderQuirks(value: unknown): ProviderQuirks {
  const input = record(value, "quirks");
  exactKeys(input, ["systemPromptSupport", "fewShotPolicy", "promptStyle", "documentPlacement",
    "historyPolicy", "samplingDefaults", "greedyDecodingSafe", "toolLoopLimit", "prefillSupported"], "quirks");
  const sampling = record(input["samplingDefaults"], "quirks.samplingDefaults");
  exactKeys(sampling, ["temperature", "topP", "topK"], "quirks.samplingDefaults");
  const toolLoopLimit = positiveInteger(input["toolLoopLimit"], "quirks.toolLoopLimit");
  return Object.freeze({
    systemPromptSupport: enumValue(input["systemPromptSupport"], ["full", "discouraged", "none"], "quirks.systemPromptSupport"),
    fewShotPolicy: enumValue(input["fewShotPolicy"], ["helps", "neutral", "harmful"], "quirks.fewShotPolicy"),
    promptStyle: enumValue(input["promptStyle"], ["xml", "markdown", "plain"], "quirks.promptStyle"),
    documentPlacement: enumValue(input["documentPlacement"], ["leading", "trailing"], "quirks.documentPlacement"),
    historyPolicy: enumValue(input["historyPolicy"], ["strip_reasoning", "round_trip_opaque", "verbatim"], "quirks.historyPolicy"),
    samplingDefaults: Object.freeze({
      temperature: nullableNumber(sampling["temperature"], "quirks.samplingDefaults.temperature"),
      topP: nullableNumber(sampling["topP"], "quirks.samplingDefaults.topP"),
      topK: nullableNumber(sampling["topK"], "quirks.samplingDefaults.topK"),
    }),
    greedyDecodingSafe: booleanValue(input["greedyDecodingSafe"], "quirks.greedyDecodingSafe"),
    toolLoopLimit,
    prefillSupported: booleanValue(input["prefillSupported"], "quirks.prefillSupported"),
  });
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`INVALID_PROFILE:${path}: expected object`);
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`INVALID_PROFILE:${path}: unknown fields ${unknown.join(",")}`);
}
export function enumValue<const T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw new Error(`INVALID_PROFILE:${path}: expected ${values.join("|")}`);
  return value as T;
}
export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`INVALID_PROFILE:${path}: expected boolean`);
  return value;
}
export function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`INVALID_PROFILE:${path}: expected non-negative number or null`);
  return value;
}
export function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`INVALID_PROFILE:${path}: expected positive integer`);
  return value as number;
}
