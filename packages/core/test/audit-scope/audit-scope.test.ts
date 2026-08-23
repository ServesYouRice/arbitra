import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_AUDIT_GRAPH, resolveAuditTarget } from "../../src/preflight/audit-scope.js";
import { resolveDiffTarget } from "../../src/preflight/diff-scope.js";
import { expandImpactedSurfaces } from "../../src/preflight/impacted-surfaces.js";

const snapshot = { id: "snapshot-1", files: [{ path: "src/auth.ts" }, { path: "src/routes.ts" }, { path: "ignored.ts", ignored: true }] };
const modules = [{ id: "auth", files: ["src/auth.ts", "src/routes.ts"], evidence: ["import:./auth"] }];
const git = { resolveDefaultBranch: () => ({ branch: "origin/trunk", reason: "remote_head" }), mergeBase: (base: string, head: string) => `mb:${base}:${head}` };

describe("audit targets", () => {
  it("resolves full, module and diff adapters over the same canonical graph", () => {
    expect(resolveAuditTarget({ kind: "full" }, snapshot, modules)).toMatchObject({ paths: ["src/auth.ts", "src/routes.ts"], graph: CANONICAL_AUDIT_GRAPH });
    expect(resolveAuditTarget({ kind: "module", moduleId: "auth" }, snapshot, modules)).toMatchObject({ moduleId: "auth", paths: ["src/auth.ts", "src/routes.ts"], graph: CANONICAL_AUDIT_GRAPH });
    expect(resolveAuditTarget({ kind: "diff", target: { kind: "staged" } }, snapshot, modules)).toMatchObject({ kind: "diff", graph: CANONICAL_AUDIT_GRAPH });
  });

  it("resolves default branch and all diff target forms without assuming main", () => {
    expect(resolveDiffTarget({ kind: "merge_base" }, git)).toMatchObject({ base: "origin/trunk", head: "HEAD", mergeBase: "mb:origin/trunk:HEAD", range: "mb:origin/trunk:HEAD...HEAD", controlPlaneRevision: "origin/trunk" });
    expect(resolveDiffTarget({ kind: "branch_range", base: "release", head: "feature" }, git).range).toBe("mb:release:feature...feature");
    expect(resolveDiffTarget({ kind: "commit_range", base: "abc123", head: "def456" }, git).range).toBe("abc123..def456");
    expect(resolveDiffTarget({ kind: "custom_range", range: "base...head" }, git).mergeBase).toBe("mb:base:head");
    expect(resolveDiffTarget({ kind: "staged" }, git)).toMatchObject({ range: "--cached", controlPlaneRevision: "HEAD" });
    expect(resolveDiffTarget({ kind: "working_tree" }, git)).toMatchObject({ range: "working-tree", controlPlaneRevision: "HEAD" });
  });

  it("always taints repository diff content and raises fork or cross-remote warning prominence", () => {
    const target = resolveDiffTarget({ kind: "merge_base", base: "origin/trunk", head: "fork/topic", source: { baseRemote: "origin", headRemote: "fork", fork: true } }, git);
    expect(target.content).toEqual({ provenance: "repo", tainted: true });
    expect(target.sourceTrust).toMatchObject({ trusted: false, fork: true, crossRemote: true });
    expect(target.warnings[0]).toMatchObject({ prominence: "prominent", code: "UNTRUSTED_FORK_OR_CROSS_REMOTE_DIFF" });
    expect(target.controlPlaneRevision).toBe("origin/trunk");
  });
});

describe("impacted surface expansion", () => {
  it("uses bounded deterministic relations and explains every included surface", () => {
    const report = expandImpactedSurfaces(["src/auth.ts"], [
      { id: "auth", files: ["src/auth.ts"], relations: [] },
      { id: "routes", files: ["src/routes.ts"], relations: [{ from: "src/auth.ts", to: "src/routes.ts", kind: "route" }] },
      { id: "unrelated", files: ["src/catalog.ts"], relations: [] },
    ]);
    expect(report.surfaces.map(({ surfaceId }) => surfaceId)).toEqual(["auth", "routes"]);
    expect(report.surfaces.every(({ reasons }) => reasons.length > 0)).toBe(true);
    expect(report.surfaces[1]?.reasons).toEqual(["route:src/auth.ts->src/routes.ts"]);
  });
});

describe("audit preset architecture", () => {
  it("keeps every shipped Audit preset on one versioned graph", () => {
    const names = ["audit-balanced", "audit-deep", "diff-fast", "diff-review", "diff-deep"];
    const presets = names.map((name) => JSON.parse(readFileSync(resolve(process.cwd(), "../workflow/src/presets", `${name}.json`), "utf8")) as { graph: unknown });
    expect(presets.every(({ graph }) => JSON.stringify(graph) === JSON.stringify(CANONICAL_AUDIT_GRAPH))).toBe(true);
  });
});
