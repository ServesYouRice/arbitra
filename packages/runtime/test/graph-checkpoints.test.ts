import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerGraph, RunnerNode } from "@arbitra/core/runner/workflow-runner.js";
import { orchestratorCore } from "../src/cli-core.js";
import { Orchestrator, type RunResource } from "../src/orchestrator.js";

/**
 * Generic gate/human nodes over the shared orchestrator. The graph is registered the way
 * an operator-authored graph will be: the runner, stores and interfaces are the shipped ones.
 */
const node = (id: string, kind: RunnerNode["kind"], config?: RunnerNode["config"]): RunnerNode => ({ id, kind, label: id, goal: id, ...(config === undefined ? {} : { config }) });
const gatedGraph = (id: string, gatePolicy: string | undefined): RunnerGraph => ({
  schemaVersion: 1, id, entryNodeId: "preflight",
  nodes: [node("preflight", "deterministic"), node("auditor-a", "model"), node("auditor-b", "model"), node("consensus", "loop"), node("verification", "subgraph"),
    node("approval", "human", { prompt: "Release the plan?" }), node("release", "gate", gatePolicy === undefined ? undefined : { policy: gatePolicy }), node("planner", "model")],
  edges: [
    { id: "p-a", from: "preflight", to: "auditor-a" }, { id: "p-b", from: "preflight", to: "auditor-b" },
    { id: "a-c", from: "auditor-a", to: "consensus" }, { id: "b-c", from: "auditor-b", to: "consensus" },
    { id: "c-v", from: "consensus", to: "verification" }, { id: "v-h", from: "verification", to: "approval" },
    { id: "h-g", from: "approval", to: "release" }, { id: "g-p", from: "release", to: "planner" },
  ],
});
const graphs = { "gated-audit": gatedGraph("gated-audit", "test_pass"), "failing-gate": gatedGraph("failing-gate", "test_fail"), "unconfigured-gate": gatedGraph("unconfigured-gate", undefined), "unknown-gate": gatedGraph("unknown-gate", "always_pass"), "quality-gate": gatedGraph("quality-gate", "quality_gate") };
const gatePolicies = { test_pass: async () => ({ passed: true, reasons: [] }), test_fail: async () => ({ passed: false, reasons: ["operator_policy_says_no"] }) };
const configFor = (preset: string, checkpoints?: unknown) => ({
  schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2,
  verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset, ...(checkpoints === undefined ? {} : { checkpoints }) },
  budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {},
});
const interactive = { mode: "interactive" };

let repository: string;
let state: string;
let sequence = 0;
// Each instance is a fresh process view over the same durable state directory.
const orchestrator = (): Orchestrator => new Orchestrator({ repository, stateDirectory: state, graphs, gatePolicies, newRunId: () => `gated-${++sequence}` });

beforeAll(async () => {
  repository = mkdtempSync(join(tmpdir(), "arbitra-gated-repo-"));
  state = mkdtempSync(join(tmpdir(), "arbitra-gated-state-"));
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src/handlers.ts"), "export const parse = (value: unknown): string => value as " + "any;\n", "utf8");
});
afterAll(() => { for (const directory of [repository, state]) rmSync(directory, { recursive: true, force: true }); });

async function blockedRun(preset = "gated-audit"): Promise<{ runId: string; version: string }> {
  const run = await orchestrator().run(configFor(preset, interactive) as never);
  expect(run.state).toBe("BLOCKED");
  const [checkpoint] = (await orchestrator().status(run.runId)).checkpoints;
  if (checkpoint?.kind !== "human") throw new Error("HUMAN_CHECKPOINT_ABSENT");
  return { runId: run.runId, version: checkpoint.version };
}

describe("unknown or unconfigured checkpoint policies", () => {
  it("are reported as preflight configuration diagnostics for registered graphs", async () => {
    const subject = orchestrator();
    expect(await subject.preflight(configFor("gated-audit", interactive))).toMatchObject({ valid: true, ready: true, preset: "gated-audit", diagnostics: [] });
    const cases: [string, unknown, string][] = [["gated-audit", undefined, "CHECKPOINT_POLICY_REQUIRED"], ["unconfigured-gate", interactive, "GATE_POLICY_REQUIRED"], ["unknown-gate", interactive, "UNKNOWN_GATE_POLICY"]];
    for (const [preset, checkpoints, code] of cases) {
      const report = await subject.preflight(configFor(preset, checkpoints));
      expect(report).toMatchObject({ valid: false, diagnostics: [{ code, severity: "error", scope: "configuration", path: "workflow.checkpoints" }] });
    }
    const cli = orchestratorCore(subject);
    const path = join(repository, "unknown-gate.json");
    await writeFile(path, JSON.stringify(configFor("unknown-gate", interactive)));
    expect(await cli.validate(path)).toMatchObject({ disposition: "failed", reasons: ["invalid_configuration", "UNKNOWN_GATE_POLICY"] });
    await rm(path);
  });

  it("fail before any run is created", async () => {
    const subject = orchestrator();
    await expect(subject.start(configFor("gated-audit") as never)).rejects.toThrow("CHECKPOINT_POLICY_REQUIRED:approval");
    await expect(subject.estimate(configFor("gated-audit") as never)).rejects.toThrow("CHECKPOINT_POLICY_REQUIRED:approval");
    await expect(subject.start(configFor("unconfigured-gate", interactive) as never)).rejects.toThrow("GATE_POLICY_REQUIRED:release");
    await expect(subject.start(configFor("unknown-gate", interactive) as never)).rejects.toThrow("UNKNOWN_GATE_POLICY:release:always_pass");
    await expect(subject.start(configFor("gated-audit", { mode: "automatic" }) as never)).rejects.toThrow("AUTOMATIC_CHECKPOINT_DECISION_REQUIRED:approval");
    await expect(subject.start(configFor("gated-audit", { mode: "sometimes" }) as never)).rejects.toThrow();
    await expect(subject.start(configFor("gated-audit", { mode: "interactive", decisions: { approval: "approve" } }) as never)).rejects.toThrow();
    await expect(subject.start(configFor("gated-audit", { mode: "automatic", decisions: { approval: "approve", ghost: "approve" } }) as never)).rejects.toThrow("UNKNOWN_CHECKPOINT_NODE:ghost");
    expect(await subject.runIds()).toEqual([]);
    expect(() => new Orchestrator({ repository, stateDirectory: state, graphs: { "audit-deep": graphs["gated-audit"] } })).toThrow("DUPLICATE_WORKFLOW_PRESET");
    expect(() => new Orchestrator({ repository, stateDirectory: state, gatePolicies: { quality_gate: gatePolicies.test_pass } })).toThrow("DUPLICATE_GATE_POLICY");
  });
});

describe("interactive generic checkpoints", () => {
  it("block, agree across graph/status/gate, survive restart, reject stale/double responses and resume only on decision", async () => {
    const first = orchestrator();
    const run = await first.run(configFor("gated-audit", interactive) as never);
    expect(run.state).toBe("BLOCKED");
    const { runId } = run;

    // Graph state: the human node was dispatched but never completed; nothing downstream ran.
    const events = [];
    for await (const event of first.events(runId)) events.push(event);
    expect(events.some((event) => event.t === "node_dispatched" && event.nodeId === "approval")).toBe(true);
    expect(events.some((event) => event.t === "node_completed" && event.nodeId === "approval")).toBe(false);
    expect(events.some((event) => event.t === "node_dispatched" && (event.nodeId === "release" || event.nodeId === "planner"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ t: "run_transition", state: "BLOCKED" });

    // Process restart: a new orchestrator reads the same pending version from disk.
    const restarted = orchestrator();
    const status = await restarted.status(runId);
    expect(status).toMatchObject({ state: "BLOCKED", checkpointMode: "interactive", checkpoints: [{ kind: "human", checkpointId: "approval", status: "pending", prompt: "Release the plan?", decisions: ["approve", "reject"] }] });
    const checkpoint = status.checkpoints[0];
    if (checkpoint?.kind !== "human") throw new Error("HUMAN_CHECKPOINT_ABSENT");
    expect((await first.status(runId)).checkpoints).toEqual(status.checkpoints);
    expect(await restarted.gate(runId)).toEqual({ gateStatus: "failed", reasons: expect.arrayContaining(["run_not_completed", "checkpoint_pending:approval"]) });

    // The CLI port reports the same run and the same public gate.
    const cli = orchestratorCore(restarted);
    expect(await cli.status(runId)).toMatchObject({ disposition: "suspended", value: { state: "BLOCKED", checkpoints: status.checkpoints } });
    const report = await cli.report(runId);
    expect(report.disposition).toBe("failed");
    expect(report.reasons).toEqual((await restarted.gate(runId)).reasons);

    // Stale and malformed responses change nothing.
    await expect(restarted.respondCheckpoint(runId, "approval", { version: "0".repeat(64), decision: "approve" })).rejects.toMatchObject({ message: "STALE_CHECKPOINT", statusCode: 409 });
    await expect(restarted.respondCheckpoint(runId, "approval", { version: checkpoint.version, decision: "continue" })).rejects.toThrow();
    await expect(restarted.respondCheckpoint(runId, "absent", { version: checkpoint.version, decision: "approve" })).rejects.toMatchObject({ statusCode: 404 });
    expect((await orchestrator().status(runId)).checkpoints).toEqual(status.checkpoints);

    const accepted = await cli.respondCheckpoint(runId, "approval", checkpoint.version, "approve");
    expect(accepted).toMatchObject({ disposition: "passed", value: { accepted: true, state: "BLOCKED", checkpoint: { status: "approved", decidedBy: "operator", version: checkpoint.version } } });
    // Deciding does not resume; a second decision, from another process, is refused.
    expect((await orchestrator().status(runId)).state).toBe("BLOCKED");
    await expect(orchestrator().respondCheckpoint(runId, "approval", { version: checkpoint.version, decision: "reject" })).rejects.toMatchObject({ message: "CHECKPOINT_ALREADY_DECIDED", statusCode: 409 });
    const decidedGate = await orchestrator().gate(runId);
    expect(decidedGate.reasons).toContain("run_not_completed");
    expect(decidedGate.reasons.filter((reason) => reason.startsWith("checkpoint_"))).toEqual([]);

    const resumed = await orchestratorCore(orchestrator()).resume(runId);
    expect(resumed).toMatchObject({ value: { state: "COMPLETED" } });
    const final = await orchestrator().status(runId);
    expect(final).toMatchObject({ state: "COMPLETED", checkpoints: [{ checkpointId: "approval", status: "approved", version: checkpoint.version }] });
    const gate = await orchestrator().gate(runId);
    expect(gate.reasons.filter((reason) => /^(checkpoint_|gate_failed|run_not_completed)/u.test(reason))).toEqual([]);
    expect(resumed.reasons).toEqual(gate.reasons);
    const artifacts = await orchestrator().artifacts(runId);
    expect(artifacts.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["checkpoint-approval", "gate-evaluation-release", "plan-ir"]));
    await expect(orchestrator().respondCheckpoint(runId, "approval", { version: checkpoint.version, decision: "approve" })).rejects.toMatchObject({ message: "CHECKPOINT_RESPONSE_REQUIRES_BLOCKED_RUN", statusCode: 409 });
  });

  it("accepts exactly one of two concurrent responses from separate processes", async () => {
    const { runId, version } = await blockedRun();
    const results = await Promise.allSettled([
      orchestrator().respondCheckpoint(runId, "approval", { version, decision: "approve" }),
      orchestrator().respondCheckpoint(runId, "approval", { version, decision: "reject" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason).toMatchObject({ message: "CHECKPOINT_ALREADY_DECIDED" });
  });

  it("reports an operator rejection as a failed policy gate, not a pass or a system failure", async () => {
    const { runId, version } = await blockedRun();
    await orchestrator().respondCheckpoint(runId, "approval", { version, decision: "reject" });
    const resumed = await orchestratorCore(orchestrator()).resume(runId);
    expect(resumed.disposition).toBe("failed");
    expect(resumed.reasons).toEqual(expect.arrayContaining(["run_not_completed", "checkpoint_rejected:approval"]));
    expect((await orchestrator().status(runId)).state).toBe("FAILED");
    expect((await orchestrator().gate(runId)).reasons).toEqual(resumed.reasons);
    // Resuming again cannot turn the rejection into approval.
    const again = orchestrator();
    await again.resume(runId);
    expect((await again.wait(runId)).state).toBe("FAILED");
    expect((await orchestrator().gate(runId)).reasons).toEqual(resumed.reasons);
  });
});

describe("automatic checkpoints and gate policies", () => {
  it("resolve human nodes only from explicit run-policy decisions", async () => {
    const approved = await orchestrator().run(configFor("gated-audit", { mode: "automatic", decisions: { approval: "approve" } }) as never);
    expect(approved.state).toBe("COMPLETED");
    expect(await orchestrator().status(approved.runId)).toMatchObject({ checkpointMode: "automatic", checkpoints: [{ checkpointId: "approval", status: "approved", decidedBy: "run_policy", mode: "automatic" }] });
    const rejected = await orchestratorCore(orchestrator()).run(await savedConfig(configFor("gated-audit", { mode: "automatic", decisions: { approval: "reject" } })));
    expect(rejected.disposition).toBe("failed");
    expect(rejected.reasons).toEqual(expect.arrayContaining(["checkpoint_rejected:approval"]));
  });

  it("fail the run on a failed gate policy and report the same reason in every view", async () => {
    const { runId, version } = await blockedRun("failing-gate");
    await orchestrator().respondCheckpoint(runId, "approval", { version, decision: "approve" });
    const resumed = await orchestratorCore(orchestrator()).resume(runId);
    expect(resumed.disposition).toBe("failed");
    expect(resumed.reasons).toEqual(expect.arrayContaining(["gate_failed:release"]));
    const status: RunResource = await orchestrator().status(runId);
    expect(status.state).toBe("FAILED");
    const evaluation = await orchestrator().artifacts(runId).then((all) => all.find(({ kind }) => kind === "gate-evaluation-release"));
    const content = JSON.parse((await orchestrator().artifact(runId, evaluation?.artifactId ?? "") as { content: string }).content) as unknown;
    expect(content).toEqual({ nodeId: "release", policy: "test_fail", passed: false, reasons: ["operator_policy_says_no"] });
  });

  it("evaluates the built-in quality gate with the public gate's own reasons", async () => {
    const { runId, version } = await blockedRun("quality-gate");
    await orchestrator().respondCheckpoint(runId, "approval", { version, decision: "approve" });
    const resumer = orchestrator();
    await resumer.resume(runId);
    const finalState = (await resumer.wait(runId)).state;
    const evaluation = await orchestrator().artifacts(runId).then((all) => all.find(({ kind }) => kind === "gate-evaluation-release"));
    const recorded = JSON.parse((await orchestrator().artifact(runId, evaluation?.artifactId ?? "") as { content: string }).content) as { passed: boolean; reasons: string[] };
    const gate = await orchestrator().gate(runId);
    // The fixture's scripted audit has degraded coverage, so the gate must stop the graph
    // before planning, and the public gate must name both the gate and its reason.
    expect(recorded).toMatchObject({ passed: false, reasons: expect.arrayContaining(["degraded_coverage"]) });
    expect(recorded.reasons).not.toContain("run_not_completed");
    expect(finalState).toBe("FAILED");
    expect(gate.reasons).toEqual(expect.arrayContaining([...recorded.reasons, "run_not_completed", "gate_failed:release"]));
    expect((await orchestrator().artifacts(runId)).some(({ kind }) => kind === "plan-ir")).toBe(false);
  });
});

async function savedConfig(config: unknown): Promise<string> {
  const path = join(state, `config-${++sequence}.json`);
  await writeFile(path, JSON.stringify(config), "utf8");
  return path;
}
