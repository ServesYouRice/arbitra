import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { orchestratorCore } from "../src/cli-core.js";
import { controlPlaneCore } from "../src/control-plane-core.js";
import { auditorIdsFor, graphForPreset } from "../src/graphs.js";
import { Orchestrator } from "../src/orchestrator.js";
import { DEFAULT_AUDITORS } from "../src/auditors.js";
import { RunStore } from "../src/run-store.js";

/**
 * The composition root's own gate.
 *
 * These run the real pipeline over a small fixture repository, so a regression that breaks
 * the wiring between two packages fails here rather than only in the browser.
 */
const REPOSITORY_FIXTURE = {
  "src/handlers.ts": [
    "export function load(map: Map<string, string>, key: string): string {",
    "  return map.get(key)" + "!.trim();",
    "}",
    "export function swallow(run: () => void): void {",
    "  try { run(); } catch {" + "}",
    "}",
    "// TO" + "DO: replace the cast below once the payload schema lands",
    "export const parse = (value: unknown): string => value as " + "any;",
  ].join("\n"),
  "src/util.ts": [
    "export function pick(values: readonly string[]): string {",
    "  return values[0]!;",
    "}",
  ].join("\n"),
};

const config = Object.freeze({
  schemaVersion: 1,
  mode: "audit",
  scope: { kind: "repository" },
  auditDepth: "balanced",
  consensusPolicy: "risk_weighted",
  maxConsensusRounds: 2,
  verification: {}, models: {}, harness: { mode: "canonical" },
  workflow: { preset: "audit-deep" },
  budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {},
});

let repository: string;
let state: string;

beforeAll(async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  repository = mkdtempSync(join(tmpdir(), "arbitra-repo-"));
  state = mkdtempSync(join(tmpdir(), "arbitra-state-"));
  for (const [path, content] of Object.entries(REPOSITORY_FIXTURE)) {
    await mkdir(join(repository, path, ".."), { recursive: true });
    await writeFile(join(repository, path), content, "utf8");
  }
});

afterAll(() => {
  for (const directory of [repository, state]) rmSync(directory, { recursive: true, force: true });
});

const orchestrator = (): Orchestrator => new Orchestrator({ repository, stateDirectory: state });

describe("the executable graph", () => {
  it("dispatches an auditor node per configured auditor", () => {
    expect(auditorIdsFor(graphForPreset("audit-deep"))).toEqual(DEFAULT_AUDITORS.map(({ auditorId }) => auditorId));
  });

  it("rejects unknown presets instead of silently executing a different graph", () => {
    expect(() => graphForPreset("not-a-preset")).toThrow("UNKNOWN_WORKFLOW_PRESET");
    expect(() => graphForPreset("__proto__")).toThrow("UNKNOWN_WORKFLOW_PRESET");
    expect(auditorIdsFor(graphForPreset("audit-balanced"))).toHaveLength(2);
    expect(auditorIdsFor(graphForPreset("diff-fast"))).toHaveLength(1);
  });
});

describe("a run over the fixture repository", () => {
  it("supports a zero-review single-source fast audit without inventing peer votes", async () => {
    const core = orchestrator();
    const result = await core.run(core.configurations.validate({ ...config, maxConsensusRounds: 0, consensusPolicy: "minimal", workflow: { preset: "diff-fast" } }));
    expect(result.state, JSON.stringify(await new RunStore(join(state, "runs"), result.runId).loadRecords())).toBe("COMPLETED");
    expect(result.summary).toMatchObject({ auditorCount: 1 });
    const operations = (await core.artifacts(result.runId)).find(({ kind }) => kind === "issue-operations");
    if (operations === undefined) throw new Error("operations absent");
    const artifact = await core.artifact(result.runId, operations.artifactId) as { content: string };
    expect(JSON.parse(artifact.content)).toEqual([]);
  });
  it("rejects uncomposed execution modes rather than silently substituting an audit", async () => {
    const core = orchestrator();
    await expect(core.start(core.configurations.validate({ ...config, mode: "feature" }))).rejects.toThrow("RUNTIME_MODE_NOT_AVAILABLE:feature");
    await expect(core.estimate(core.configurations.validate({ ...config, mode: "testing" }))).rejects.toThrow("RUNTIME_MODE_NOT_AVAILABLE:testing");
    await expect(core.start(core.configurations.validate({ ...config, harness: { mode: "native" } }))).rejects.toThrow("RUNTIME_NATIVE_HARNESS_NOT_AVAILABLE");
  });
  it("runs the two-auditor graph without requesting nonexistent third-auditor artifacts", async () => {
    const core = orchestrator();
    const result = await core.run(core.configurations.validate({ ...config, workflow: { preset: "diff-review" } }));
    expect(result.state).toBe("COMPLETED");
    expect(result.summary).toMatchObject({ auditorCount: 2 });
  });

  it("refuses to resume against changed repository content", async () => {
    const core = orchestrator();
    const started = await core.start(core.configurations.validate(config));
    await core.cancel(started.runId);
    const { writeFile, rm } = await import("node:fs/promises");
    const added = join(repository, "changed.ts");
    try {
      await writeFile(added, "export const changed = true;\n");
      await expect(core.resume(started.runId)).rejects.toThrow("RUN_REPOSITORY_CHANGED");
    } finally { await rm(added); }
  });
  it("walks every node, publishes the artifacts the UI reads, and grounds each issue in evidence", async () => {
    const core = orchestrator();
    const { runId, state: runState } = await core.run(core.configurations.validate(config));
    expect(runState).toBe("COMPLETED");

    const kinds = (await core.artifacts(runId)).map(({ kind }) => kind);
    for (const kind of ["preflight", "source-findings", "issue-operations", "verification-results", "canonical-issues", "plan-ir", "critic-feedback"]) {
      expect(kinds).toContain(kind);
    }

    const summary = await core.summary(runId) as { auditorCount: number; sourceFindingCount: number; acceptedCount: number };
    expect(summary.auditorCount).toBe(3);
    expect(summary.sourceFindingCount).toBeGreaterThan(0);

    // Every canonical issue must trace back to a real source finding and cite a real
    // repository location: the evidence chain is the point, so no issue may exist without one.
    const issues = await read<{ issues: readonly { candidateId: string; sourceFindingIds: readonly string[] }[] }>(core, runId, "canonical-issues");
    const findings = await read<readonly { sourceFindingId: string; locations: readonly { path: string; startLine: number }[] }[]>(core, runId, "source-findings");
    const known = new Set(findings.map(({ sourceFindingId }) => sourceFindingId));
    expect(issues.issues.length).toBeGreaterThan(0);
    for (const issue of issues.issues) {
      expect(issue.sourceFindingIds.length).toBeGreaterThan(0);
      for (const id of issue.sourceFindingIds) expect(known).toContain(id);
    }
    for (const finding of findings) {
      expect(finding.locations.length).toBeGreaterThan(0);
      for (const { path, startLine } of finding.locations) {
        expect(Object.keys(REPOSITORY_FIXTURE)).toContain(path);
        expect(startLine).toBeGreaterThan(0);
      }
    }
  });

  it("fails the gate closed while coverage is degraded", async () => {
    const core = orchestrator();
    const { runId } = await core.run(core.configurations.validate(config));
    const gate = await core.gate(runId);
    expect(gate.gateStatus).toBe("failed");
    expect(gate.reasons).toContain("degraded_coverage");
  });

  it("replays the recorded events to a subscriber that arrives after the run finished", async () => {
    const core = orchestrator();
    const { runId } = await core.run(core.configurations.validate(config));
    const events = [];
    for await (const event of core.events(runId)) events.push(event);
    expect(events.filter(({ t }) => t === "node_completed").map((event) => (event as { nodeId: string }).nodeId))
      .toEqual(expect.arrayContaining(["preflight", "auditor-a", "auditor-b", "auditor-c", "consensus", "verification", "planner", "critic"]));
  });
});

describe("the CLI port", () => {
  it("turns a degraded-coverage run into a failed gate, never a silent pass", async () => {
    const core = orchestratorCore(orchestrator());
    const result = await core.audit({ preset: "audit-deep", target: { kind: "full" } });
    expect(result.disposition).toBe("failed");
    expect(result.reasons).toContain("degraded_coverage");
  });

  it("reports an unparseable configuration as a failure rather than throwing", async () => {
    const core = orchestratorCore(orchestrator());
    const result = await core.validate(join(repository, "src/util.ts"));
    expect(result.disposition).toBe("failed");
    expect(result.reasons).toContain("invalid_configuration");
  });

  it("replays recorded discovery under new policy while preserving the source run", async () => {
    const runtime = orchestrator();
    const original = await runtime.run(runtime.configurations.validate(config));
    const before = await runtime.artifacts(original.runId);
    const result = await orchestratorCore(runtime).replay(original.runId, { consensusPolicy: "minimal", maximumRounds: 1, criticEnabled: false });
    expect(result.disposition).toBe("failed");
    const replayedId = (result.value as { runId: string }).runId;
    expect(replayedId).not.toBe(original.runId);
    expect(await runtime.artifacts(original.runId)).toEqual(before);
    const provenance = await read<{ sourceRunId: string; reusedArtifacts: readonly unknown[] }>(runtime, replayedId, "replay-source");
    expect(provenance).toMatchObject({ sourceRunId: original.runId });
    expect(provenance.reusedArtifacts).toHaveLength(3);
    expect((await runtime.diff(original.runId, replayedId)).addedIssueIds).toEqual([]);
  });
});

describe("the control-plane port", () => {
  it("round-trips a configuration and starts a run from its id", async () => {
    const core = controlPlaneCore(orchestrator());
    const saved = await core.configurations.save({ name: "fixture", config }) as { id: string };
    expect((await core.configurations.list()).map(({ id }) => id)).toContain(saved.id);
    const started = await core.runs.start({ configurationId: saved.id }) as { runId: string };
    expect(started.runId).toMatch(/^run-/u);
  });

  it("uses the selected repository for estimates and runs, and persists it for resume", async () => {
    const alternate = mkdtempSync(join(tmpdir(), "arbitra-selected-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(alternate, "only.ts"), "export const selected = true;\n", "utf8");
      const orchestrated = orchestrator();
      const core = controlPlaneCore(orchestrated);
      const saved = await core.configurations.save({ name: "selected", config }) as { id: string };
      await core.repositories.select({ path: alternate });
      const estimated = await core.runs.estimate({ configurationId: saved.id }) as { estimate: { files: number } };
      expect(estimated.estimate.files).toBe(1);
      const started = await core.runs.start({ configurationId: saved.id }) as { runId: string };
      const events = [];
      for await (const event of core.runs.events(started.runId)) events.push(event);
      expect(events.at(-1)).toMatchObject({ t: "run_transition", state: "COMPLETED" });
      const stored = await new RunStore(join(state, "runs"), started.runId).loadContext();
      expect(stored.repository).toBe(resolve(alternate));
      expect(stored.maximumRounds).toBe(config.maxConsensusRounds);
    } finally { rmSync(alternate, { recursive: true, force: true }); }
  });

  it("rejects cancellation of an unknown run instead of fabricating success", async () => {
    await expect(orchestrator().cancel("run-absent")).rejects.toThrow("RUN_ABSENT:run-absent");
  });

  it("reports evaluation metrics as unavailable rather than as zero", async () => {
    const core = controlPlaneCore(orchestrator());
    const saved = await core.configurations.save({ name: "metrics", config }) as { id: string };
    const started = await core.runs.start({ configurationId: saved.id }) as { runId: string };
    const metrics = await core.evaluation.metrics(started.runId) as { rows: readonly unknown[]; cacheHitRate: number | null; independence: { applicable: boolean } };
    expect(metrics.rows).toHaveLength(0);
    expect(metrics.cacheHitRate).toBeNull();
    expect(metrics.independence.applicable).toBe(false);
  });

  it("rejects a comparison side that names no protocol identity", async () => {
    const core = controlPlaneCore(orchestrator());
    await expect(core.evaluation.compare({ a: {}, b: { protocolIdentity: "p" } })).rejects.toThrow("COMPARISON_SIDE_REQUIRES_PROTOCOL_IDENTITY");
  });
});

/** Read one published artifact back by kind, the way the UI addresses them. */
async function read<T>(core: Orchestrator, runId: string, kind: string): Promise<T> {
  const descriptor = (await core.artifacts(runId)).find((item) => item.kind === kind);
  if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`);
  const resource = await core.artifact(runId, descriptor.artifactId) as { content: string };
  return JSON.parse(resource.content) as T;
}
