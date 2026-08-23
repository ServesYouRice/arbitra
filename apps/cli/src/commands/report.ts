import { redactSecrets, REDACTION_PATTERN_VERSION } from "@arbitra/security/redaction";
import type { CoreCommandResult } from "../core.js";

/**
 * `report <run-id>` renders the evaluation surface for one run.
 *
 * The core returns exactly what the guarded query layer produced: an identity refusal is
 * a refusal, and an unmeasured value is null, never zero. This command adds one thing —
 * outbound redaction — and then fails closed if anything secret-shaped survived it, so no
 * report can leave the application unredacted.
 */
export interface ReportCommandPort { report(runId: string): Promise<CoreCommandResult> }
export interface RedactedReport { readonly report: unknown; readonly redaction: { readonly patternVersion: typeof REDACTION_PATTERN_VERSION; readonly count: number } }

export async function executeReport(core: ReportCommandPort, argv: readonly string[]): Promise<CoreCommandResult> {
  const [runId, ...options] = argv;
  if (runId === undefined || runId.startsWith("--")) return { disposition: "system_failure", reasons: ["missing_argument:report"], value: null };
  if (options.length !== 0) return { disposition: "system_failure", reasons: ["invalid_arguments:report"], value: null };
  const result = await core.report(runId);
  if (result.value === undefined || result.value === null) return result;
  const redacted = redactReport(result.value);
  const residue = redactSecrets(JSON.stringify(redacted.report)).redactions;
  if (residue.length > 0) return { disposition: "system_failure", reasons: ["report_redaction_failed"], value: null };
  return { ...result, value: redacted };
}

export function redactReport(value: unknown): RedactedReport {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") { const { text, redactions } = redactSecrets(node); count += redactions.length; return text; }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    return node;
  };
  const report = walk(value);
  return { report, redaction: { patternVersion: REDACTION_PATTERN_VERSION, count } };
}
