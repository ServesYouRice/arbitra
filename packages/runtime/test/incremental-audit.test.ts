import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import type { CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { incrementalFixture, moduleSource, defect } from "./incremental-fixture.js";
import { runDigest } from "./replay-fixture.js";
import type { Orchestrator } from "../src/orchestrator.js";
import { orchestratorCore } from "../src/cli-core.js";
import { controlPlaneCore } from "../src/control-plane-core.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function fixture(files: Readonly<Record<string, string>>, options: { readonly git?: boolean } = {}) {
  const f = await incrementalFixture(files, options); cleanups.push(f.cleanup); return f;
}

const incremental = (config: RunConfig, baseRunId: string, changes: Partial<RunConfig> = {}): RunConfig => runConfigSchema.parse({ ...config, ...changes, workflow: { ...(changes.workflow ?? config.workflow), incremental: { baseRunId } } });
type Report = Awaited<ReturnType<Orchestrator["incrementalReport"]>>;
const regenerated = (report: Report) => [...new Set(report.units.filter(({ decision }) => decision === "regenerate").flatMap(({ paths }) => paths))].sort();
const reasonsFor = (report: Report, path: string) => [...new Set(report.units.filter(({ paths }) => paths.includes(path)).flatMap(({ reasons }) => reasons))].sort();

async function issues(orchestrator: Orchestrator, runId: string): Promise<string[]> {
  const artifact = (await orchestrator.artifacts(runId)).find(({ kind }) => kind === "canonical-issues");
  if (artifact === undefined) throw new Error("CANONICAL_ISSUES_ABSENT");
  const set = (await orchestrator.artifact(runId, artifact.artifactId) as { content: string }).content;
  return (JSON.parse(set) as CanonicalIssueSet).issues.map(({ claim, disposition, verificationOutcome, supportCount }) => `${claim.title}|${disposition}|${verificationOutcome ?? "none"}|${supportCount}`).sort();
}

const baseTree = {
  "package.json": '{"name":"fixture"}\n',
  "src/alpha.ts": moduleSource("alpha", ["alpha"]),
  "src/beta.ts": moduleSource("beta", ["beta"], { imports: ["./beta-util.js"] }),
  "src/beta-util.ts": "export const betaUtil = 1;\n",
  "pkg/package.json": '{"name":"pkg"}\n',
  "pkg/gamma.ts": moduleSource("gamma", ["gamma"]),
};

/** A completed base over `baseTree`, and a probe that audits one change against it and then restores the tree. */
async function invalidationProbe() {
  const f = await fixture(baseTree);
  const orchestrator = f.orchestrator();
  const base = await orchestrator.run(f.config);
  expect(base.state).toBe("COMPLETED");
  return async (tree: Readonly<Record<string, string | null>>, changes: Partial<RunConfig> = {}) => {
    await f.write(tree);
    f.calls.length = 0;
    const result = await orchestrator.run(incremental(f.config, base.runId, changes));
    expect(result.state).toBe("COMPLETED");
    const report = await orchestrator.incrementalReport(result.runId);
    await f.write(baseTree);
    return { report, discovery: f.calls.filter(({ stage }) => stage === "discovery").map(({ activity }) => activity).sort() };
  };
}

describe("incremental and repeat audits", () => {
  it("reruns an identical snapshot with no provider calls, reusing every unit and stage without touching the base", async () => {
    const f = await fixture(baseTree);
    const orchestrator = f.orchestrator();
    const base = await orchestrator.run(f.config);
    expect(base.state).toBe("COMPLETED");
    const baseCalls = f.calls.length;
    expect(f.calls.filter(({ stage }) => stage === "discovery")).toHaveLength(6);
    const before = await runDigest(f.root, base.runId);
    f.calls.length = 0;
    const repeat = await orchestrator.run(incremental(f.config, base.runId));
    expect(repeat.state).toBe("COMPLETED");
    expect(f.calls).toEqual([]);
    expect(await runDigest(f.root, base.runId)).toBe(before);
    const report = await orchestrator.incrementalReport(repeat.runId);
    expect(report).toMatchObject({ strategy: "incremental", fallbackReasons: [], changedPaths: { added: [], removed: [], modified: [] } });
    expect(report.units).toHaveLength(6);
    expect(report.units.every(({ decision, reusedFrom }) => decision === "reuse" && reusedFrom?.runId === base.runId)).toBe(true);
    expect(report.stages.every(({ decision }) => decision === "reuse")).toBe(true);
    expect(report.savedWork.modelCalls).toEqual({ reused: baseCalls, made: 0 });
    expect(report.savedWork.tokensSaved).toEqual({ inputTokens: 100 * baseCalls, outputTokens: 10 * baseCalls, callsWithUnknownUsage: 0 });
    expect(report.coverage.degradedVersusFullRun).toBe(false);
    expect(await issues(orchestrator, repeat.runId)).toEqual(await issues(orchestrator, base.runId));
    // Every reused finding names the base artifact it came from, and matches it exactly.
    const results = (await orchestrator.artifacts(repeat.runId)).filter(({ kind }) => kind.startsWith("incremental-unit-result-"));
    expect(results).toHaveLength(6);
    for (const result of results) {
      const content = JSON.parse((await orchestrator.artifact(repeat.runId, result.artifactId) as { content: string }).content) as { findingsMatchBase: boolean; findings: { reusedFrom?: { runId: string } }[] };
      expect(content.findingsMatchBase).toBe(true);
      expect(content.findings.every(({ reusedFrom }) => reusedFrom?.runId === base.runId)).toBe(true);
    }
    // A repeat of the repeat chains to its own base and still makes no call.
    const third = await orchestrator.run(incremental(f.config, repeat.runId));
    expect(third.state).toBe("COMPLETED");
    expect(f.calls).toEqual([]);
  });

  it("invalidates exactly the units whose cited lines, uncited lines or imports changed", async () => {
    const probe = await invalidationProbe();
    const cited = await probe({ "src/alpha.ts": baseTree["src/alpha.ts"].replace(defect("alpha"), defect("alpha").replace("JSON.parse(input)", "JSON.parse(input ?? '{}')")) });
    expect(regenerated(cited.report)).toEqual(["src/alpha.ts"]);
    expect(reasonsFor(cited.report, "src/alpha.ts")).toEqual(["changed:cited_lines:src/alpha.ts:1-1", "changed:footprint:src/alpha.ts"]);
    expect(cited.discovery).toEqual(["auditor-a:src/alpha.ts", "auditor-b:src/alpha.ts"]);
    expect(cited.report.stages.every(({ decision, reasons }) => decision === "regenerate" && reasons.includes("changed:repository"))).toBe(true);

    // An edit to uncited lines still changes the footprint, but not the cited lines.
    const uncited = await probe({ "src/alpha.ts": baseTree["src/alpha.ts"].replace("alpha context line 5 ", "alpha context line five ") });
    expect(regenerated(uncited.report)).toEqual(["src/alpha.ts"]);
    expect(reasonsFor(uncited.report, "src/alpha.ts")).toEqual(["changed:footprint:src/alpha.ts"]);

    const imported = await probe({ "src/beta-util.ts": "export const betaUtil = 2;\n" });
    expect(regenerated(imported.report)).toEqual(["src/beta-util.ts", "src/beta.ts"]);
    expect(reasonsFor(imported.report, "src/beta.ts")).toEqual(["changed:footprint:src/beta-util.ts", "changed:imports:src/beta-util.ts"]);
    expect(imported.discovery).toEqual(["auditor-a:src/beta-util.ts,src/beta.ts", "auditor-b:src/beta-util.ts,src/beta.ts"]);
  });

  it("invalidates exactly the units whose nested or root manifests changed", async () => {
    const probe = await invalidationProbe();
    const nested = await probe({ "pkg/package.json": '{"name":"pkg","dependencies":{"left-pad":"1.3.0"}}\n' });
    expect(regenerated(nested.report)).toEqual(["pkg/gamma.ts"]);
    expect(reasonsFor(nested.report, "pkg/gamma.ts")).toEqual(["changed:manifests:pkg/package.json"]);
    expect(nested.report.affectedSurfaces.surfaces.map(({ surfaceId }) => surfaceId)).toEqual(["pkg/gamma"]);

    const root = await probe({ "package.json": '{"name":"fixture","type":"module"}\n' });
    expect(regenerated(root.report)).toEqual(["pkg/gamma.ts", "src/alpha.ts", "src/beta-util.ts", "src/beta.ts"]);
    expect(root.report.units.every(({ reasons }) => reasons.includes("changed:manifests:package.json"))).toBe(true);
  });

  it("invalidates the required units and stages when exclusions or policy change", async () => {
    const probe = await invalidationProbe();
    const excluded = await probe({}, { scope: { kind: "repository", exclude: ["pkg"] } });
    expect(excluded.report.units.map(({ paths }) => paths.join(","))).not.toContain("pkg/gamma.ts");
    expect(excluded.report.units.every(({ decision, reasons }) => decision === "regenerate" && reasons.includes("changed:scope"))).toBe(true);
    expect(excluded.report.changedPaths.removed).toEqual(["pkg/gamma.ts"]);

    // Consensus policy cannot change what independent discovery saw: discovery is reused, downstream stages are not.
    const consensus = await probe({}, { consensusPolicy: "full" });
    expect(regenerated(consensus.report)).toEqual([]);
    expect(consensus.discovery).toEqual([]);
    expect(consensus.report.stages.map(({ decision, reasons }) => `${decision}:${reasons.join(",")}`)).toEqual(["regenerate:changed:policy", ...Array(3).fill("regenerate:changed:policy,changed:upstream")]);

    const depth = await probe({}, { auditDepth: "deep" });
    expect(regenerated(depth.report)).toEqual(["pkg/gamma.ts", "src/alpha.ts", "src/beta-util.ts", "src/beta.ts"]);
    expect(depth.report.units.every(({ reasons }) => reasons.join() === "changed:policy")).toBe(true);
  });

  it("matches a full audit on moved, fixed, recurring and new defects while saving discovery work", async () => {
    const v1 = {
      "src/alpha.ts": moduleSource("alpha", ["alpha"]),
      "src/beta.ts": moduleSource("beta", ["beta"]),
      "src/gamma.ts": moduleSource("gamma", ["gamma"]),
      "src/delta.ts": moduleSource("delta", []),
      "src/epsilon.ts": moduleSource("epsilon", []),
    };
    const f = await fixture(v1);
    const orchestrator = f.orchestrator();
    const base = await orchestrator.run(f.config);
    expect(base.state).toBe("COMPLETED");
    // recurring: alpha unchanged; fixed: beta; moved: gamma shifted by inserted lines; new: delta.
    await f.write({ "src/beta.ts": moduleSource("beta", []), "src/gamma.ts": moduleSource("gamma", ["gamma"], { offset: 3 }), "src/delta.ts": moduleSource("delta", ["delta"]) });
    f.calls.length = 0;
    const full = await orchestrator.run(f.config);
    const fullCalls = [...f.calls];
    f.calls.length = 0;
    const next = await orchestrator.run(incremental(f.config, base.runId));
    const incrementalCalls = [...f.calls];
    expect([full.state, next.state]).toEqual(["COMPLETED", "COMPLETED"]);
    const expected = ["Unchecked parse alpha|accepted|none|2", "Unchecked parse delta|accepted|none|2", "Unchecked parse gamma|accepted|none|2"];
    expect(await issues(orchestrator, full.runId)).toEqual(expected);
    expect(await issues(orchestrator, next.runId)).toEqual(expected);
    const summary = async (runId: string) => { const rest = { ...await orchestrator.summary(runId) as Record<string, unknown> }; delete rest["runId"]; delete rest["artifacts"]; delete rest["incremental"]; return rest; };
    expect(await summary(next.runId)).toEqual(await summary(full.runId));
    const count = (calls: typeof fullCalls, stage?: string) => calls.filter((call) => stage === undefined || call.stage === stage).length;
    expect(count(fullCalls, "discovery")).toBe(10);
    expect(count(incrementalCalls, "discovery")).toBe(6);
    expect(count(incrementalCalls)).toBe(count(fullCalls) - 4);    const report = await orchestrator.incrementalReport(next.runId);
    expect(report.savedWork.discoveryUnits).toEqual({ total: 10, reused: 4, regenerated: 6 });
    expect(report.savedWork.modelCalls).toEqual({ reused: 4, made: count(incrementalCalls) });
    expect(report.savedWork.tokensSaved).toEqual({ inputTokens: 400, outputTokens: 40, callsWithUnknownUsage: 0 });
    expect(report.coverage).toMatchObject({ snapshotPaths: 5, degradedVersusFullRun: false, reusedUnitLimitations: [] });
    expect(report.coverage.byAuditor.map(({ uncoveredPaths }) => uncoveredPaths)).toEqual([[], []]);
    expect(regenerated(report)).toEqual(["src/beta.ts", "src/delta.ts", "src/gamma.ts"]);
    const lineage = Object.fromEntries((report.baseFindingLineage ?? []).map(({ locations, status }) => [locations[0]?.path ?? "", status]));
    expect(lineage).toEqual({ "src/alpha.ts": "unchanged", "src/beta.ts": "absent", "src/gamma.ts": "moved" });
    expect(report.baseFindingLineage?.find(({ status }) => status === "moved")?.locations[0]?.to).toEqual({ path: "src/gamma.ts", startLine: 4, endLine: 4 });
    // Round zero stays independent: fresh discovery sees source only, never base or peer findings.
    for (const call of incrementalCalls.filter(({ stage }) => stage === "discovery")) expect(call.user).not.toMatch(/sourceFindingId|Unchecked parse|auditor-[ab]\//u);
  });

  it("resumes an interrupted incremental run under its recorded decisions without repeating completed units", async () => {
    const f = await fixture(baseTree);
    const orchestrator = f.orchestrator();
    const base = await orchestrator.run(f.config);
    await f.write({ "src/alpha.ts": moduleSource("alpha", ["alpha", "alpha-two"]), "pkg/gamma.ts": moduleSource("gamma", []) });
    f.calls.length = 0;
    f.fail("pkg/gamma.ts");
    const failed = await orchestrator.run(incremental(f.config, base.runId));
    expect(failed.state).toBe("FAILED");
    const decisions = async (runId: string) => (await orchestrator.artifacts(runId)).filter(({ kind }) => kind.startsWith("incremental-unit-") && !kind.startsWith("incremental-unit-result-")).map(({ artifactId }) => artifactId).sort();
    const recorded = await decisions(failed.runId);
    const firstAttempt = f.calls.filter(({ stage }) => stage === "discovery").map(({ activity }) => activity);
    f.recover(); f.calls.length = 0;
    const resumed = f.orchestrator();
    await resumed.resume(failed.runId);
    expect((await resumed.wait(failed.runId)).state).toBe("COMPLETED");
    const secondAttempt = f.calls.filter(({ stage }) => stage === "discovery").map(({ activity }) => activity);
    // Each changed alpha unit is paid for exactly once across both attempts, unchanged units
    // never, and only the failed gamma units are dispatched again.
    const all = [...firstAttempt, ...secondAttempt];
    expect(all.filter((activity) => activity.endsWith("src/alpha.ts")).sort()).toEqual(["auditor-a:src/alpha.ts", "auditor-b:src/alpha.ts"]);
    expect(all.some((activity) => activity.includes("src/beta"))).toBe(false);
    expect(secondAttempt.filter((activity) => activity.endsWith("pkg/gamma.ts")).length).toBeGreaterThan(0);
    expect((await decisions(failed.runId)).filter((id) => recorded.includes(id))).toEqual(recorded);
    const report = await resumed.incrementalReport(failed.runId);
    expect(regenerated(report)).toEqual(["pkg/gamma.ts", "src/alpha.ts"]);
    expect(report.units.filter(({ paths }) => paths.includes("src/beta.ts")).every(({ decision }) => decision === "reuse")).toBe(true);
    expect(await issues(resumed, failed.runId)).toEqual(["Unchecked parse alpha-two|accepted|none|2", "Unchecked parse alpha|accepted|none|2", "Unchecked parse beta|accepted|none|2"]);
  });

  it("falls back to a full audit for an unfinished base, and records why", async () => {
    const f = await fixture(baseTree);
    const orchestrator = f.orchestrator();
    f.fail("src/alpha.ts");
    const failedBase = await orchestrator.run(f.config);
    expect(failedBase.state).toBe("FAILED");
    f.recover(); f.calls.length = 0;
    const fromFailed = await orchestrator.run(incremental(f.config, failedBase.runId));
    expect(fromFailed.state).toBe("COMPLETED");
    const fallback = await orchestrator.incrementalReport(fromFailed.runId);
    expect(fallback).toMatchObject({ strategy: "full_fallback", fallbackReasons: ["base_run_not_completed:FAILED"] });
    expect(fallback.units.every(({ decision, reasons }) => decision === "regenerate" && reasons[0] === "full_audit_fallback")).toBe(true);
    expect(f.calls.filter(({ stage }) => stage === "discovery")).toHaveLength(6);
  });

  it("falls back to a full audit when the executed graph or the Git history changed", async () => {
    const f = await fixture(baseTree);
    const orchestrator = f.orchestrator();
    const base = await orchestrator.run(f.config);
    // Reuse is bound to the executed graph's identity: a different graph is a full audit.
    f.calls.length = 0;
    const otherGraph = await orchestrator.run(incremental(f.config, base.runId, { workflow: { ...f.config.workflow, preset: "diff-review" } }));
    expect(otherGraph.state).toBe("COMPLETED");
    expect(await orchestrator.incrementalReport(otherGraph.runId)).toMatchObject({ strategy: "full_fallback", fallbackReasons: ["workflow_graph_changed"] });
    expect(f.calls.filter(({ stage }) => stage === "discovery")).toHaveLength(6);
    await f.git("commit", "-q", "--amend", "-m", "rewritten");
    f.calls.length = 0;
    const rewritten = await orchestrator.run(incremental(f.config, base.runId));
    expect(rewritten.state).toBe("COMPLETED");
    expect(await orchestrator.incrementalReport(rewritten.runId)).toMatchObject({ strategy: "full_fallback", fallbackReasons: ["git_history_rewritten"] });
    expect(f.calls.filter(({ stage }) => stage === "discovery")).toHaveLength(6);
  });

  it("rejects an absent base, a base of another mode and a scripted incremental request before creating a run", async () => {
    const f = await fixture(baseTree, { git: false });
    const orchestrator = f.orchestrator();
    const scripted = runConfigSchema.parse({ ...f.config, models: {}, workflow: { preset: "audit-balanced" } });
    const scriptedBase = await orchestrator.run(scripted);
    const before = (await orchestrator.runIds()).length;
    await expect(orchestrator.start(incremental(f.config, "run-absent"))).rejects.toMatchObject({ message: "INCREMENTAL_BASE_ABSENT:run-absent", statusCode: 404 });
    await expect(orchestrator.start(incremental(f.config, scriptedBase.runId))).rejects.toMatchObject({ message: "INCREMENTAL_BASE_MODE_MISMATCH:scripted_audit", statusCode: 409 });
    await expect(orchestrator.start(incremental(scripted, scriptedBase.runId))).rejects.toThrow(/INCREMENTAL_REQUIRES_MODEL_AUDIT/u);
    expect((await orchestrator.preflight(incremental(scripted, scriptedBase.runId))).diagnostics.map(({ code }) => code)).toContain("INCREMENTAL_REQUIRES_MODEL_AUDIT");
    expect(orchestrator.validate({ ...f.config, mode: "feature", workflow: { ...f.config.workflow, incremental: { baseRunId: scriptedBase.runId } } }).valid).toBe(false);
    expect((await orchestrator.runIds()).length).toBe(before);
    // Without Git history the byte identities still decide reuse.
    const base = await orchestrator.run(f.config);
    f.calls.length = 0;
    const repeat = await orchestrator.run(incremental(f.config, base.runId));
    expect(f.calls).toEqual([]);
    expect((await orchestrator.incrementalReport(repeat.runId)).gitChangedPaths).toBeNull();
    await expect(orchestrator.incrementalReport(base.runId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("gives the CLI and HTTP cores the same incremental decisions for the same request", async () => {
    const f = await fixture(baseTree);
    const orchestrator = f.orchestrator();
    const base = await orchestrator.run(f.config);
    await f.write({ "src/alpha.ts": moduleSource("alpha", ["alpha"], { offset: 1 }) });
    const configPath = join(f.root, "incremental-config.json");
    await writeFile(configPath, JSON.stringify(f.config));
    const cli = await orchestratorCore(orchestrator).run(configPath, { incremental: { baseRunId: base.runId } });
    expect((cli.value as { state: string }).state).toBe("COMPLETED");
    const cliRunId = (cli.value as { runId: string }).runId;
    const http = controlPlaneCore(orchestrator);
    const saved = await orchestrator.configurations.save("fixture", f.config) as { id: string };
    const started = await http.runs.start({ configurationId: saved.id, incremental: { baseRunId: base.runId } });
    const httpRun = await orchestrator.wait(started.runId);
    expect(httpRun.state).toBe("COMPLETED");
    const view = (report: Report) => report.units.map(({ unitKey, decision, reasons }) => ({ unitKey, decision, reasons }));
    const cliReport = await orchestratorCore(orchestrator).incremental(cliRunId);
    expect(view(cliReport.value as Report)).toEqual(view(await http.incremental.report(started.runId)));
    expect(regenerated(cliReport.value as Report)).toEqual(["src/alpha.ts"]);
    await expect(http.runs.start({ configurationId: saved.id, incremental: { baseRunId: "../escape" } })).rejects.toMatchObject({ statusCode: 400 });
  });
});
