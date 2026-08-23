import type { ExitPolicyDecision } from "../exit-policy.js";

export const CLI_JSON_SCHEMA_VERSION = 1 as const;

export interface CliJsonOutput {
  readonly schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  readonly command: string;
  readonly ok: boolean;
  readonly policy: ExitPolicyDecision;
  readonly result: unknown;
}

/** Stable public machine-output schema for every CLI command. */
export const CLI_JSON_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "command", "ok", "policy", "result"],
  properties: {
    schemaVersion: { const: CLI_JSON_SCHEMA_VERSION },
    command: { type: "string", minLength: 1 },
    ok: { type: "boolean" },
    result: {},
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["exit", "gateStatus", "reasons"],
      properties: {
        exit: { enum: [0, 1, 2, 3] },
        gateStatus: { enum: ["passed", "failed", "system_failure", "suspended"] },
        reasons: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
  },
} as const;

export function createJsonOutput(
  command: string,
  policy: ExitPolicyDecision,
  result: unknown,
): CliJsonOutput {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command,
    ok: policy.exit === 0,
    policy,
    result: result ?? null,
  };
}

export function isCliJsonOutput(value: unknown): value is CliJsonOutput {
  if (!isRecord(value) || Object.keys(value).some((key) => !["schemaVersion", "command", "ok", "policy", "result"].includes(key))) return false;
  if (value.schemaVersion !== CLI_JSON_SCHEMA_VERSION || typeof value.command !== "string" || value.command.length === 0 || typeof value.ok !== "boolean") return false;
  if (!("result" in value) || !isRecord(value.policy)) return false;
  const policy = value.policy;
  return Object.keys(policy).every((key) => ["exit", "gateStatus", "reasons"].includes(key))
    && [0, 1, 2, 3].includes(policy.exit as number)
    && ["passed", "failed", "system_failure", "suspended"].includes(policy.gateStatus as string)
    && Array.isArray(policy.reasons)
    && policy.reasons.every((reason) => typeof reason === "string" && reason.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
