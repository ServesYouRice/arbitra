import type { ZodIssue, ZodType } from "zod";

import type { SemanticDiagnostic } from "./semantic/finding.js";

export const structuredOutputTiers = [
  "native_structured",
  "schema_tool_call",
  "json_mode",
  "prompt_json",
] as const;

export type StructuredOutputTier = (typeof structuredOutputTiers)[number];

export interface StructuredOutputCallRecord {
  readonly structuredOutputTier: StructuredOutputTier;
  readonly parseFailures: number;
  readonly repairCount: number;
  readonly semanticValidationFailures: number;
}

export interface RepairDiagnostic {
  readonly pointer: string;
  readonly message: string;
}

export interface RepairInput {
  readonly invalidOutput: string;
  readonly callRecord: StructuredOutputCallRecord;
}

export interface RepairRequest {
  readonly kind: "structured_output_repair";
  readonly invalidOutput: string;
  readonly diagnostics: readonly RepairDiagnostic[];
  readonly instruction: string;
  readonly callRecord: StructuredOutputCallRecord;
}

export interface StructuredOutputResult<T> {
  readonly value: T;
  readonly callRecord: StructuredOutputCallRecord;
}

export class StructuredOutputError extends Error {
  public constructor(
    message: string,
    public readonly diagnostics: readonly RepairDiagnostic[],
    public readonly callRecord: StructuredOutputCallRecord,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function issuePointer(issue: ZodIssue): string {
  return issue.path.length === 0
    ? "/"
    : `/${issue.path.map((segment) => escapePointer(String(segment))).join("/")}`;
}

type ParseResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly diagnostics: readonly RepairDiagnostic[] };

function parse<T>(schema: ZodType<T>, raw: string): ParseResult<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      success: false,
      diagnostics: [{
        pointer: "/",
        message: error instanceof Error ? `invalid JSON: ${error.message}` : "invalid JSON",
      }],
    };
  }
  const result = schema.safeParse(decoded);
  if (!result.success) {
    return {
      success: false,
      diagnostics: result.error.issues.map((issue) => ({
        pointer: issuePointer(issue),
        message: issue.message,
      })),
    };
  }
  return { success: true, value: result.data };
}

export function repairOnce(
  request: RepairInput,
  diagnostics: readonly RepairDiagnostic[],
): RepairRequest {
  if (request.callRecord.repairCount !== 0) {
    throw new StructuredOutputError(
      "structured output repair limit reached",
      diagnostics,
      request.callRecord,
    );
  }
  return {
    kind: "structured_output_repair",
    invalidOutput: request.invalidOutput,
    diagnostics,
    instruction: "Return corrected JSON only. Fix the listed JSON pointers; the schema is unchanged.",
    callRecord: {
      ...request.callRecord,
      repairCount: 1,
    },
  };
}

export async function processStructuredOutput<T>(options: {
  readonly schema: ZodType<T>;
  readonly output: string;
  readonly tier: StructuredOutputTier;
  readonly requestRepair: (request: RepairRequest) => Promise<string>;
  readonly validateSemantics?: (value: T) => readonly SemanticDiagnostic[];
}): Promise<StructuredOutputResult<T>> {
  let callRecord: StructuredOutputCallRecord = {
    structuredOutputTier: options.tier,
    parseFailures: 0,
    repairCount: 0,
    semanticValidationFailures: 0,
  };
  let parsed = parse(options.schema, options.output);

  if (!parsed.success) {
    callRecord = { ...callRecord, parseFailures: 1 };
    const repairRequest = repairOnce({ invalidOutput: options.output, callRecord }, parsed.diagnostics);
    callRecord = repairRequest.callRecord;
    const repairedOutput = await options.requestRepair(repairRequest);
    parsed = parse(options.schema, repairedOutput);
    if (!parsed.success) {
      callRecord = { ...callRecord, parseFailures: 2 };
      throw new StructuredOutputError(
        "structured output remained invalid after one repair",
        parsed.diagnostics,
        callRecord,
      );
    }
  }

  const semanticDiagnostics = options.validateSemantics?.(parsed.value) ?? [];
  if (semanticDiagnostics.length > 0) {
    callRecord = { ...callRecord, semanticValidationFailures: semanticDiagnostics.length };
    throw new StructuredOutputError(
      "structured output failed semantic validation",
      semanticDiagnostics,
      callRecord,
    );
  }

  return { value: parsed.value, callRecord };
}
