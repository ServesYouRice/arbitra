import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { orchestratorCore } from "../src/cli-core.js";
import { controlPlaneCore } from "../src/control-plane-core.js";
import { auditorIdsFor, graphForPreset } from "../src/graphs.js";
import { Orchestrator } from "../src/orchestrator.js";
import { DEFAULT_AUDITORS } from "../src/auditors.js";

/**
 * The composition root's own gate.
 *
 * These run the real pipeline over a small fixture repository, so a regression that breaks
 * the wiring between two packages fails here rather than only in the browser.
 */
const REPOSITORY_FIXTURE = {
  "src/handlers.ts": [
    "export function load(map: Map<string, string>, key: string): string {",
    "  return map.get(key)!.trim();",
    "}",
    "export function swallow(run: () => void): void {",
    "  try { run(); } catch {}",
    "}",
    "// TODO: replace the cast below once the payload schema lands",
    "export const parse = (value: unknown): string => value as any;",
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

  it("falls back to audit-deep for an unknown preset rather than throwing", () => {
    expect(graphForPreset("not-a-preset").id).toBe("audit-deep");
  });
});

describe("a run over the fixture repository", () => {
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

  it("refuses replay rather than passing off a fresh run as one", async () => {
    const result = await orchestratorCore(orchestrator()).replay("run-does-not-exist");
    expect(result.disposition).toBe("system_failure");
    expect(result.reasons).toContain("replay_not_wired");
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
