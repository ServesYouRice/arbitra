import type { CoreCommandResult } from "../core.js";

export type AuditCliTarget = Readonly<{ kind: "full" } | { kind: "module"; moduleId: string } | { kind: "diff"; target: "staged" | "working_tree" | "range"; base?: string; head?: string; range?: string }>;
export interface AuditCommandPort { audit(request: { readonly preset: string; readonly target: AuditCliTarget }): Promise<CoreCommandResult> }

/**
 * `audit --preset` configures no models (a model run needs endpoints and credentials that only a configuration holds),
 * so its auditors are the scripted detectors. The spec review of October 24, 2026 found that nothing in its output
 * said so: `audit: failed (reasons: degraded_coverage)` reads like a model audit that found gaps.
 */
export const AUDIT_USAGE = [
  "usage: arbitra audit [--preset audit-balanced|audit-deep|diff-fast|diff-review] (--full | --module <path> | --staged | --working-tree | --base <ref> [--head <ref>] | --range <revisions>)",
  "This runs the preset over the target with scripted detectors: no model is configured and none is called, so it checks the pipeline and the plainest defects, not what a model audit finds.",
  "For a model audit, run arbitra run <config> with models set in workflow.modelExecution (templates in examples/model-backed, steps in docs/setup.md under \"Preparing a live run\"), or start a new run in the app.",
].join("\n");

export async function executeAudit(core: AuditCommandPort, argv: readonly string[]): Promise<CoreCommandResult> {
  if (argv.includes("--help") || argv.includes("-h")) return { disposition: "passed", reasons: [], value: { usage: AUDIT_USAGE } };
  const preset = option(argv, "--preset") ?? "audit-balanced"; const moduleId = option(argv, "--module"); const base = option(argv, "--base"); const head = option(argv, "--head"); const range = option(argv, "--range");
  const flags = [argv.includes("--full"), moduleId !== undefined, argv.includes("--staged"), argv.includes("--working-tree"), base !== undefined || head !== undefined || range !== undefined].filter(Boolean).length;
  if (flags !== 1) return { disposition: "system_failure", reasons: [flags === 0 ? "missing_audit_target" : "conflicting_audit_targets"], value: { usage: AUDIT_USAGE } };
  let target: AuditCliTarget;
  if (argv.includes("--full")) target = { kind: "full" };
  else if (moduleId !== undefined) target = { kind: "module", moduleId };
  else if (argv.includes("--staged")) target = { kind: "diff", target: "staged" };
  else if (argv.includes("--working-tree")) target = { kind: "diff", target: "working_tree" };
  else target = { kind: "diff", target: "range", ...(base === undefined ? {} : { base }), ...(head === undefined ? {} : { head }), ...(range === undefined ? {} : { range }) };
  return core.audit(Object.freeze({ preset, target: Object.freeze(target) }));
}
function option(argv: readonly string[], name: string): string | undefined { const index = argv.indexOf(name); if (index < 0) return undefined; const value = argv[index + 1]; if (value === undefined || value.startsWith("--")) throw new Error(`missing_value:${name}`); return value; }
