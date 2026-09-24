import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Orchestrator, type RunnerGraph } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { buildServer } from "../src/main.js";

type RunnerNode = RunnerGraph["nodes"][number];

const node = (id: string, kind: RunnerNode["kind"], config?: RunnerNode["config"]): RunnerNode => ({ id, kind, label: id, goal: id, ...(config === undefined ? {} : { config }) });
const graph: RunnerGraph = {
  schemaVersion: 1, id: "gated-audit", entryNodeId: "preflight",
  nodes: [node("preflight", "deterministic"), node("auditor-a", "model"), node("consensus", "loop"), node("verification", "subgraph"), node("approval", "human", { prompt: "Release?" }), node("release", "gate", { policy: "operator_pass" }), node("planner", "model")],
  edges: [{ id: "1", from: "preflight", to: "auditor-a" }, { id: "2", from: "auditor-a", to: "consensus" }, { id: "3", from: "consensus", to: "verification" }, { id: "4", from: "verification", to: "approval" }, { id: "5", from: "approval", to: "release" }, { id: "6", from: "release", to: "planner" }],
};
const config = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "fast", consensusPolicy: "minimal", maxConsensusRounds: 0, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "gated-audit", checkpoints: { mode: "interactive" } }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };

it("serves durable generic checkpoints that agree with the CLI port and survive a server restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-http-"));
  const options = { repository: root, graphs: { "gated-audit": graph }, gatePolicies: { operator_pass: async () => ({ passed: true, reasons: [] }) } };
  const orchestrator = new Orchestrator(options);
  const app = buildServer(controlPlaneCore(orchestrator));
  try {
    await writeFile(join(root, "index.ts"), "export const value = 1;\n");
    const saved = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Gated", config } });
    expect(saved.statusCode, saved.body).toBe(200);
    const unconfigured = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Unknown", config: { ...config, workflow: { preset: "gated-audit", checkpoints: { mode: "whenever" } } } } });
    expect(unconfigured.statusCode).toBeGreaterThanOrEqual(400); expect(unconfigured.body).toContain("checkpoints");
    const noPolicy = await app.inject({ method: "POST", url: "/configurations", payload: { name: "None", config: { ...config, workflow: { preset: "gated-audit" } } } });
    const refused = await app.inject({ method: "POST", url: "/runs", payload: { configurationId: noPolicy.json<{ id: string }>().id } });
    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({ message: "CHECKPOINT_POLICY_REQUIRED:approval" });

    const started = await app.inject({ method: "POST", url: "/runs", payload: { configurationId: saved.json<{ id: string }>().id } });
    const { runId } = started.json<{ runId: string }>();
    expect((await orchestrator.wait(runId)).state).toBe("BLOCKED");
    const status = await app.inject({ method: "GET", url: `/runs/${runId}` });
    const resource = status.json<{ state: string; checkpoints: { kind: string; checkpointId: string; version: string; status: string }[] }>();
    expect(resource).toMatchObject({ state: "BLOCKED", checkpointMode: "interactive", checkpoints: [{ kind: "human", checkpointId: "approval", status: "pending", prompt: "Release?" }] });
    // HTTP, the CLI port and the orchestrator report one run and one gate.
    const cli = orchestratorCore(orchestrator);
    expect((await cli.status(runId)).value).toEqual(resource);
    expect((await cli.report(runId)).reasons).toEqual((await orchestrator.gate(runId)).reasons);
    expect((await orchestrator.gate(runId)).reasons).toContain("checkpoint_pending:approval");
    const version = resource.checkpoints[0]?.version ?? "";

    const url = `/runs/${runId}/checkpoints/approval`;
    expect((await app.inject({ method: "POST", url, payload: { decision: "approve" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, payload: { version, decision: "continue" } })).statusCode).toBe(400);
    const stale = await app.inject({ method: "POST", url, payload: { version: "0".repeat(64), decision: "approve" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ message: "STALE_CHECKPOINT" });
    expect((await app.inject({ method: "POST", url: `/runs/${runId}/checkpoints/absent`, payload: { version, decision: "approve" } })).statusCode).toBe(404);

    // Restart: a new server and orchestrator over the same state directory.
    const restartedOrchestrator = new Orchestrator(options);
    const restarted = buildServer(controlPlaneCore(restartedOrchestrator));
    try {
      expect((await restarted.inject({ method: "GET", url: `/runs/${runId}` })).json()).toEqual(resource);
      const approved = await restarted.inject({ method: "POST", url, payload: { version, decision: "approve" } });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({ accepted: true, state: "BLOCKED", checkpoint: { status: "approved", decidedBy: "operator", version } });
      const duplicate = await app.inject({ method: "POST", url, payload: { version, decision: "reject" } });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ message: "CHECKPOINT_ALREADY_DECIDED" });
      expect((await restarted.inject({ method: "GET", url: `/runs/${runId}` })).json()).toMatchObject({ state: "BLOCKED", checkpoints: [{ status: "approved" }] });

      expect((await restarted.inject({ method: "POST", url: `/runs/${runId}/resume` })).statusCode).toBe(200);
      expect((await restartedOrchestrator.wait(runId)).state).toBe("COMPLETED");
      const final = (await restarted.inject({ method: "GET", url: `/runs/${runId}` })).json();
      expect(final).toMatchObject({ state: "COMPLETED", checkpoints: [{ checkpointId: "approval", status: "approved", version }] });
      expect((await cli.status(runId)).value).toEqual(final);
      const gate = await restartedOrchestrator.gate(runId);
      expect(gate.reasons.filter((reason) => /^(checkpoint_|gate_failed|run_not_completed)/u.test(reason))).toEqual([]);
      expect((await cli.report(runId)).reasons ?? []).toEqual(gate.reasons);
      const late = await restarted.inject({ method: "POST", url, payload: { version, decision: "approve" } });
      expect(late.statusCode).toBe(409);
    } finally { await restarted.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
