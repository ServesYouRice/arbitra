import type { ApproximatedModule } from "./modules.js";

export type AuditTargetSpec = Readonly<{ kind: "full" } | { kind: "module"; moduleId: string } | { kind: "diff"; target: unknown }>;
export interface AuditSnapshot { readonly id: string; readonly files: readonly { readonly path: string; readonly ignored?: boolean }[] }
export type AuditTarget = Readonly<
  { kind: "full"; snapshotId: string; paths: readonly string[]; graph: typeof CANONICAL_AUDIT_GRAPH }
  | { kind: "module"; snapshotId: string; moduleId: string; paths: readonly string[]; moduleEvidence: readonly string[]; graph: typeof CANONICAL_AUDIT_GRAPH }
  | { kind: "diff"; snapshotId: string; diffSpec: unknown; graph: typeof CANONICAL_AUDIT_GRAPH }
>;

export const CANONICAL_AUDIT_GRAPH = Object.freeze({ id: "canonical-audit", version: 1 as const });

export function resolveAuditTarget(spec: AuditTargetSpec, snapshot: AuditSnapshot, modules: readonly ApproximatedModule[]): AuditTarget {
  if (snapshot.id.trim() === "") throw new Error("INVALID_AUDIT_SNAPSHOT");
  const snapshotPaths = new Set(snapshot.files.filter(({ ignored }) => ignored !== true).map(({ path }) => normalize(path)));
  if (spec.kind === "full") return Object.freeze({ kind: "full", snapshotId: snapshot.id, paths: Object.freeze([...snapshotPaths].sort()), graph: CANONICAL_AUDIT_GRAPH });
  if (spec.kind === "diff") return Object.freeze({ kind: "diff", snapshotId: snapshot.id, diffSpec: spec.target, graph: CANONICAL_AUDIT_GRAPH });
  const module = modules.find(({ id }) => id === spec.moduleId); if (module === undefined) throw new Error(`UNKNOWN_AUDIT_MODULE:${spec.moduleId}`);
  const paths = module.files.map(normalize).filter((path) => snapshotPaths.has(path)).sort(); if (paths.length === 0) throw new Error(`EMPTY_AUDIT_MODULE:${spec.moduleId}`);
  return Object.freeze({ kind: "module", snapshotId: snapshot.id, moduleId: module.id, paths: Object.freeze(paths), moduleEvidence: Object.freeze([...module.evidence]), graph: CANONICAL_AUDIT_GRAPH });
}
function normalize(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//u, ""); }
