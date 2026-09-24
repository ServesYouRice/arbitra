import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Orchestrator, type RunnerGraph } from "@arbitra/runtime/orchestrator.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { runCli } from "../src/main.js";

type RunnerNode = RunnerGraph["nodes"][number];
const node = (id: string, kind: RunnerNode["kind"], config?: RunnerNode["config"]): RunnerNode => ({ id, kind, label: id, goal: id, ...(config === undefined ? {} : { config }) });
const graph: RunnerGraph = {
  schemaVersion: 1, id: "gated-audit", entryNodeId: "preflight",
  nodes: [node("preflight", "deterministic"), node("auditor-a", "model"), node("consensus", "loop"), node("verification", "subgraph"), node("approval", "human"), node("planner", "model")],
  edges: [{ id: "1", from: "preflight", to: "auditor-a" }, { id: "2", from: "auditor-a", to: "consensus" }, { id: "3", from: "consensus", to: "verification" }, { id: "4", from: "verification", to: "approval" }, { id: "5", from: "approval", to: "planner" }],
};
const io = { writeStdout: () => undefined, writeStderr: () => undefined };

it("blocks on a generic checkpoint with exit 3, records one versioned decision, and resumes with the public gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-cli-"));
  const cli = () => orchestratorCore(new Orchestrator({ repository: root, graphs: { "gated-audit": graph } }));
  try {
    await writeFile(join(root, "index.ts"), "export const value = 1;\n");
    const configPath = join(root, "gated.json");
    const config = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "fast", consensusPolicy: "minimal", maxConsensusRounds: 0, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "gated-audit", checkpoints: { mode: "interactive" } }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
    await writeFile(configPath, JSON.stringify(config));
    const unconfiguredPath = join(root, "unconfigured.json");
    await writeFile(unconfiguredPath, JSON.stringify({ ...config, workflow: { preset: "gated-audit" } }));
    const unconfigured = await runCli(["run", unconfiguredPath, "--json"], cli(), io);
    expect(unconfigured.exit).toBe(2);
    // Refused by runtime preflight, before any run exists, as an actionable diagnostic.
    expect(unconfigured.output).toMatchObject({ policy: { reasons: ["preflight_failed", "CHECKPOINT_POLICY_REQUIRED"] }, result: { diagnostics: [{ code: "CHECKPOINT_POLICY_REQUIRED", path: "workflow.checkpoints", message: expect.stringContaining("CHECKPOINT_POLICY_REQUIRED:approval") }] } });

    const run = await runCli(["run", configPath, "--json"], cli(), io);
    expect(run.exit).toBe(3);
    const blocked = run.output.result as { runId: string; state: string; checkpoints: { checkpointId: string; version: string; status: string }[] };
    expect(blocked).toMatchObject({ state: "BLOCKED", checkpoints: [{ checkpointId: "approval", status: "pending" }] });
    const { runId } = blocked;
    const version = blocked.checkpoints[0]?.version ?? "";
    const status = await runCli(["status", runId, "--json"], cli(), io);
    expect(status.exit).toBe(3);
    expect(status.output.result).toEqual(blocked);
    const report = await runCli(["report", runId, "--json"], cli(), io);
    expect(report.exit).toBe(1);
    expect(report.output.policy.reasons).toEqual(expect.arrayContaining(["run_not_completed", "checkpoint_pending:approval"]));

    const stale = await runCli(["respond-checkpoint", runId, "approval", "0".repeat(64), "approve", "--json"], cli(), io);
    expect(stale.exit).toBe(2);
    expect(stale.output.result).toMatchObject({ message: "STALE_CHECKPOINT" });
    expect((await runCli(["respond-checkpoint", runId, "approval", version, "--json"], cli(), io)).exit).toBe(2);
    expect((await runCli(["respond-checkpoint", runId, "approval", version, "approve", "--json"], cli(), io)).exit).toBe(0);
    const double = await runCli(["respond-checkpoint", runId, "approval", version, "approve", "--json"], cli(), io);
    expect(double.exit).toBe(2);
    expect(double.output.result).toMatchObject({ message: "CHECKPOINT_ALREADY_DECIDED" });

    const resumed = await runCli(["resume", runId, "--json"], cli(), io);
    const finalReport = await runCli(["report", runId, "--json"], cli(), io);
    expect(resumed.output.result).toMatchObject({ state: "COMPLETED", gateStatus: finalReport.output.policy.gateStatus });
    expect(resumed.exit).toBe(finalReport.exit);
    expect(resumed.output.policy.reasons).toEqual(finalReport.output.policy.reasons);
    expect(finalReport.output.policy.reasons.filter((reason: string) => reason.startsWith("checkpoint_"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
