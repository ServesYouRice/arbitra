import { describe, expect, it } from "vitest";
import {
  CheckpointRejectedError, GateFailedError, GraphCheckpoints, validateGraphCheckpoints,
  type CheckpointDecisionRecord, type GateEvaluationRecord, type GraphCheckpointStorePort, type HumanCheckpointRecord,
} from "../../src/runner/graph-checkpoints.js";
import { RunCheckpointError } from "../../src/runner/suspension.js";
import type { NodeExecutionContext, RunnerGraph, RunnerNode } from "../../src/runner/workflow-runner.js";

const human: RunnerNode = { id: "approval", kind: "human", label: "Approve release", goal: "approve" };
const gate = (policy?: string): RunnerNode => ({ id: "release", kind: "gate", label: "Release gate", goal: "gate", ...(policy === undefined ? {} : { config: { policy } }) });
const graph = (...nodes: RunnerNode[]): RunnerGraph => ({ schemaVersion: 1, id: "g", entryNodeId: nodes[0]?.id ?? "x", nodes, edges: [] });
const context = (node: RunnerNode, input: unknown = { issues: 1 }): NodeExecutionContext => ({ runId: "run-1", node, inputs: new Map([["upstream", input]]), signal: new AbortController().signal });
const policies = { pass: async () => ({ passed: true, reasons: [] }), fail: async () => ({ passed: false, reasons: ["unresolved_issues"] }) };

/** A store with the same create-once contract as the run-directory adapter. */
function memoryStore(): GraphCheckpointStorePort {
  const heads = new Map<string, HumanCheckpointRecord>();
  const decisions = new Map<string, CheckpointDecisionRecord>();
  const gates = new Map<string, GateEvaluationRecord>();
  return {
    current: async (id) => heads.get(id) ?? null,
    open: async (record) => { heads.set(record.checkpointId, record); },
    decision: async (id, version) => decisions.get(`${id}:${version}`) ?? null,
    decide: async (record) => {
      const key = `${record.checkpointId}:${record.version}`;
      if (decisions.has(key)) return false;
      decisions.set(key, record); return true;
    },
    recordGate: async (record) => { gates.set(record.nodeId, record); },
    gateEvaluation: async (id) => gates.get(id) ?? null,
  };
}

describe("generic checkpoint policy validation", () => {
  it("fails explicitly for unknown or unconfigured policies instead of approving", () => {
    expect(() => validateGraphCheckpoints(graph(gate()), undefined, policies)).toThrow("GATE_POLICY_REQUIRED:release");
    expect(() => validateGraphCheckpoints(graph(gate("always")), undefined, policies)).toThrow("UNKNOWN_GATE_POLICY:release:always");
    expect(() => validateGraphCheckpoints(graph(gate("__proto__")), undefined, policies)).toThrow("UNKNOWN_GATE_POLICY");
    expect(() => validateGraphCheckpoints(graph(human), undefined, policies)).toThrow("CHECKPOINT_POLICY_REQUIRED:approval");
    expect(() => validateGraphCheckpoints(graph(human), { mode: "automatic", decisions: {} }, policies)).toThrow("AUTOMATIC_CHECKPOINT_DECISION_REQUIRED:approval");
    expect(() => validateGraphCheckpoints(graph(human), { mode: "interactive", decisions: { other: "approve" } }, policies)).toThrow("UNKNOWN_CHECKPOINT_NODE:other");
    expect(() => validateGraphCheckpoints(graph(human), { mode: "sometimes" } as never, policies)).toThrow("UNKNOWN_CHECKPOINT_POLICY");
    expect(() => validateGraphCheckpoints(graph({ ...human, id: "bad/id" }), { mode: "interactive", decisions: {} }, policies)).toThrow("INVALID_CHECKPOINT_NODE_ID");
    // Graphs without gate/human nodes need no policy.
    expect(() => validateGraphCheckpoints(graph({ id: "a", kind: "deterministic", label: "A", goal: "a" }), undefined, {})).not.toThrow();
  });

  it("does not run an executor for an unconfigured node even if validation was skipped", async () => {
    const { gate: gateExecutor, human: humanExecutor } = new GraphCheckpoints(memoryStore(), undefined, policies).executors();
    await expect(humanExecutor(context(human))).rejects.toThrow("CHECKPOINT_POLICY_REQUIRED:approval");
    await expect(gateExecutor(context(gate("unknown")))).rejects.toThrow("UNKNOWN_GATE_POLICY");
  });
});

describe("interactive human checkpoints", () => {
  it("block until the current version is decided, once, and never auto-acknowledge", async () => {
    const store = memoryStore();
    const checkpoints = new GraphCheckpoints(store, { mode: "interactive", decisions: {} }, policies);
    const { human: execute } = checkpoints.executors();
    await expect(execute(context(human))).rejects.toBeInstanceOf(RunCheckpointError);
    // Re-dispatch without a decision still blocks; nothing is acknowledged implicitly.
    await expect(execute(context(human))).rejects.toBeInstanceOf(RunCheckpointError);
    const [pending] = await checkpoints.list(graph(human));
    expect(pending).toMatchObject({ checkpointId: "approval", status: "pending", mode: "interactive", prompt: "Approve release", decisions: ["approve", "reject"] });
    const version = pending?.version ?? "";
    expect(version).toMatch(/^[a-f0-9]{64}$/u);
    expect(await checkpoints.gateReasons(graph(human))).toEqual(["checkpoint_pending:approval"]);

    await expect(checkpoints.respond("approval", "0".repeat(64), "approve")).rejects.toMatchObject({ code: "STALE_CHECKPOINT", statusCode: 409 });
    await expect(checkpoints.respond("missing", version, "approve")).rejects.toMatchObject({ code: "CHECKPOINT_NOT_FOUND", statusCode: 404 });
    await expect(checkpoints.respond("approval", version, "approve")).resolves.toMatchObject({ decision: "approve", decidedBy: "operator" });
    await expect(checkpoints.respond("approval", version, "reject")).rejects.toMatchObject({ code: "CHECKPOINT_ALREADY_DECIDED", statusCode: 409 });
    await expect(execute(context(human))).resolves.toEqual({ checkpointId: "approval", version, decision: "approve", decidedBy: "operator" });
    expect(await checkpoints.gateReasons(graph(human))).toEqual([]);

    // Changed inputs are a new subject: the earlier approval does not carry over.
    await expect(execute(context(human, { issues: 2 }))).rejects.toBeInstanceOf(RunCheckpointError);
    const [next] = await checkpoints.list(graph(human));
    expect(next?.version).not.toBe(version);
    expect(next?.status).toBe("pending");
    await expect(checkpoints.respond("approval", version, "approve")).rejects.toMatchObject({ code: "STALE_CHECKPOINT" });
  });

  it("turns a rejection into an explicit policy failure", async () => {
    const checkpoints = new GraphCheckpoints(memoryStore(), { mode: "interactive", decisions: {} }, policies);
    const { human: execute } = checkpoints.executors();
    await expect(execute(context(human))).rejects.toBeInstanceOf(RunCheckpointError);
    const [pending] = await checkpoints.list(graph(human));
    await checkpoints.respond("approval", pending?.version ?? "", "reject");
    await expect(execute(context(human))).rejects.toBeInstanceOf(CheckpointRejectedError);
    expect(await checkpoints.gateReasons(graph(human))).toEqual(["checkpoint_rejected:approval"]);
  });
});

describe("automatic human checkpoints and gates", () => {
  it("apply only explicit run-policy decisions and refuse operator responses", async () => {
    const checkpoints = new GraphCheckpoints(memoryStore(), { mode: "automatic", decisions: { approval: "approve" } }, policies);
    await expect(checkpoints.executors().human(context(human))).resolves.toMatchObject({ decision: "approve", decidedBy: "run_policy" });
    const [view] = await checkpoints.list(graph(human));
    expect(view).toMatchObject({ status: "approved", decidedBy: "run_policy", mode: "automatic" });
    await expect(checkpoints.respond("approval", view?.version ?? "", "reject")).rejects.toMatchObject({ code: "CHECKPOINT_NOT_INTERACTIVE" });
    const rejecting = new GraphCheckpoints(memoryStore(), { mode: "automatic", decisions: { approval: "reject" } }, policies);
    await expect(rejecting.executors().human(context(human))).rejects.toThrow("CHECKPOINT_REJECTED:approval");
  });

  it("persist every gate evaluation and fail the node when its policy fails", async () => {
    const store = memoryStore();
    const checkpoints = new GraphCheckpoints(store, undefined, { ...policies, silent: async () => ({ passed: false, reasons: [] }) });
    await expect(checkpoints.executors().gate(context(gate("pass")))).resolves.toEqual({ gate: "release", policy: "pass", passed: true, reasons: [] });
    await expect(checkpoints.executors().gate(context(gate("fail")))).rejects.toBeInstanceOf(GateFailedError);
    expect(await store.gateEvaluation("release")).toEqual({ nodeId: "release", policy: "fail", passed: false, reasons: ["unresolved_issues"] });
    expect(await checkpoints.gateReasons(graph(gate("fail")))).toEqual(["gate_failed:release"]);
    await expect(checkpoints.executors().gate(context(gate("silent")))).rejects.toThrow("GATE_FAILED:release:gate_policy_failed");
  });
});
