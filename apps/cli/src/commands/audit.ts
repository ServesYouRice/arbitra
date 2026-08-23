import type { CoreCommandResult } from "../core.js";

export type AuditCliTarget = Readonly<{ kind: "full" } | { kind: "module"; moduleId: string } | { kind: "diff"; target: "staged" | "working_tree" | "range"; base?: string; head?: string; range?: string }>;
export interface AuditCommandPort { audit(request: { readonly preset: string; readonly target: AuditCliTarget }): Promise<CoreCommandResult> }

export async function executeAudit(core: AuditCommandPort, argv: readonly string[]): Promise<CoreCommandResult> {
  const preset = option(argv, "--preset") ?? "audit-balanced"; const moduleId = option(argv, "--module"); const base = option(argv, "--base"); const head = option(argv, "--head"); const range = option(argv, "--range");
  const flags = [argv.includes("--full"), moduleId !== undefined, argv.includes("--staged"), argv.includes("--working-tree"), base !== undefined || head !== undefined || range !== undefined].filter(Boolean).length;
  if (flags !== 1) return { disposition: "system_failure", reasons: [flags === 0 ? "missing_audit_target" : "conflicting_audit_targets"], value: null };
  let target: AuditCliTarget;
  if (argv.includes("--full")) target = { kind: "full" };
  else if (moduleId !== undefined) target = { kind: "module", moduleId };
  else if (argv.includes("--staged")) target = { kind: "diff", target: "staged" };
  else if (argv.includes("--working-tree")) target = { kind: "diff", target: "working_tree" };
  else target = { kind: "diff", target: "range", ...(base === undefined ? {} : { base }), ...(head === undefined ? {} : { head }), ...(range === undefined ? {} : { range }) };
  return core.audit(Object.freeze({ preset, target: Object.freeze(target) }));
}
function option(argv: readonly string[], name: string): string | undefined { const index = argv.indexOf(name); if (index < 0) return undefined; const value = argv[index + 1]; if (value === undefined || value.startsWith("--")) throw new Error(`missing_value:${name}`); return value; }
