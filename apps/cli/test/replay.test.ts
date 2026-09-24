import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { runCli } from "../src/main.js";

const io = { writeStdout: () => undefined, writeStderr: () => undefined };
const config = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "audit-balanced" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };

it("replays from an explicit request file through the shared orchestrator and fails mode mismatches closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "replay-cli-"));
  const cli = () => orchestratorCore(new Orchestrator({ repository: root }));
  try {
    await writeFile(join(root, "index.ts"), "export const value = 1;\n");
    const configPath = join(root, "audit.json");
    await writeFile(configPath, JSON.stringify(config));
    const run = await runCli(["run", configPath, "--json"], cli(), io);
    const { runId } = run.output.result as { runId: string };

    const auditPath = join(root, "audit-replay.json");
    await writeFile(auditPath, JSON.stringify({ mode: "audit", consensusPolicy: "full", maximumRounds: 1, criticEnabled: false }));
    const replayed = await runCli(["replay", runId, "--request", auditPath, "--json"], cli(), io);
    const result = replayed.output.result as { runId: string; state: string };
    expect(result).toMatchObject({ state: "COMPLETED" });
    expect(result.runId).not.toBe(runId);
    const report = await runCli(["report", result.runId, "--json"], cli(), io);
    expect(replayed.exit).toBe(report.exit);

    const featurePath = join(root, "feature-replay.json");
    await writeFile(featurePath, JSON.stringify({ mode: "feature" }));
    const mismatch = await runCli(["replay", runId, "--request", featurePath, "--json"], cli(), io);
    expect(mismatch.exit).toBe(2);
    expect(mismatch.output.result).toMatchObject({ message: "REPLAY_MODE_MISMATCH:audit:feature" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
