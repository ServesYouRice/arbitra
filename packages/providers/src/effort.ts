export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export type EffortParameter = string | number | boolean | null;

export interface EffortProfile {
  readonly supported: readonly EffortLevel[];
  readonly collapse: Readonly<Partial<Record<EffortLevel, EffortLevel>>>;
  readonly params: Readonly<Partial<Record<EffortLevel, Readonly<Record<string, EffortParameter>>>>>;
}

export interface EffortResolution {
  readonly applied: EffortLevel;
  readonly collapsedFrom: EffortLevel | null;
  readonly params: Readonly<Record<string, EffortParameter>>;
}

export function resolveEffort(profile: { readonly effort: EffortProfile }, requested: EffortLevel): EffortResolution {
  if (profile.effort.supported.includes(requested)) {
    return Object.freeze({ applied: requested, collapsedFrom: null, params: profile.effort.params[requested] ?? Object.freeze({}) });
  }
  const applied = profile.effort.collapse[requested];
  if (applied === undefined || !profile.effort.supported.includes(applied)) {
    throw new Error(`UNSUPPORTED_EFFORT:${requested}: profile must declare an explicit collapse target`);
  }
  return Object.freeze({ applied, collapsedFrom: requested, params: profile.effort.params[applied] ?? Object.freeze({}) });
}

export function parseEffortProfile(value: unknown): EffortProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_PROFILE:effort: expected object");
  const input = value as Record<string, unknown>;
  const supportedInput = input["supported"];
  if (!Array.isArray(supportedInput) || supportedInput.length === 0) throw new Error("INVALID_PROFILE:effort.supported: expected non-empty array");
  const supported = supportedInput.map((level) => effortLevel(level, "effort.supported"));
  if (new Set(supported).size !== supported.length) throw new Error("INVALID_PROFILE:effort.supported: duplicate level");
  const collapseInput = plainRecord(input["collapse"], "effort.collapse");
  const collapse = Object.fromEntries(Object.entries(collapseInput).map(([from, to]) => [
    effortLevel(from, "effort.collapse key"), effortLevel(to, `effort.collapse.${from}`),
  ])) as Partial<Record<EffortLevel, EffortLevel>>;
  const paramsInput = plainRecord(input["params"], "effort.params");
  const params: Partial<Record<EffortLevel, Readonly<Record<string, EffortParameter>>>> = {};
  for (const [level, raw] of Object.entries(paramsInput)) {
    const parsedLevel = effortLevel(level, "effort.params key");
    const rawParams = plainRecord(raw, `effort.params.${level}`);
    for (const [key, parameter] of Object.entries(rawParams)) {
      if (!["string", "number", "boolean"].includes(typeof parameter) && parameter !== null) throw new Error(`INVALID_PROFILE:effort.params.${level}.${key}`);
    }
    params[parsedLevel] = Object.freeze(rawParams as Record<string, EffortParameter>);
  }
  for (const level of EFFORT_LEVELS) {
    if (!supported.includes(level) && collapse[level] === undefined) throw new Error(`INVALID_PROFILE:effort.collapse.${level}: missing explicit collapse`);
  }
  return Object.freeze({ supported: Object.freeze(supported), collapse: Object.freeze(collapse), params: Object.freeze(params) });
}

function effortLevel(value: unknown, path: string): EffortLevel {
  if (typeof value !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(value)) throw new Error(`INVALID_PROFILE:${path}: invalid effort level`);
  return value as EffortLevel;
}
function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`INVALID_PROFILE:${path}: expected object`);
  return value as Record<string, unknown>;
}
