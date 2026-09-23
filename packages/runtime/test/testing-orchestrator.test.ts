import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { featureFixture } from "./feature-fixture.js";
import { Orchestrator } from "../src/orchestrator.js";
import { orchestratorCore } from "../src/cli-core.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(scenario = "complete") {
  const root = await mkdtemp(join(tmpdir(), "testing-orchestrator-")); roots.push(root);
  const f = await featureFixture(root);
  const execute = scenario.startsWith("execute-");
  const empty = scenario === "empty" || scenario === "execute-empty";
  const execution = { authorization: { maximumParallelTasks: 1, partitions: [{ id: "tests", paths: ["session.unit.test.ts"] }], tasks: [{ taskId: "TASK-001", partitionId: "tests", exclusive: false }] },
    verification: { execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: 4, checks: [{ id: "tests", executable: "/usr/bin/npm", arguments: ["run", "test"], sourcePaths: ["session.unit.test.ts"] }] },
      bindings: [{ command: "npm run test", checkId: "tests", expectedExitCode: 0, authorization: "repository_script" }] },
    models: { fast: "planner", balanced: "planner", frontier: "planner" }, maximumAttempts: 1 };
  await writeFile(join(root, "session.unit.test.ts"), "test('unrelated', () => {});\n");
  if (scenario !== "no-command") await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  const config = runConfigSchema.parse({ ...f.config, mode: "testing", models: { ...f.config.models, planner: { ...f.config.models["planner"], capabilityTier: "frontier" } }, workflow: {
    preset: execute ? "testing-execute" : "testing-plan", testing: { mode: execute ? "execute" : "plan", ...(execute ? { execution } : {}), goal: "Protect session behavior", roles: { analyst: "planner", planner: "planner" } }, modelExecution: f.config.workflow["modelExecution"],
  } });
  const risk = { summary: "Session coverage", surfaces: empty ? [] : [{ id: "session", paths: ["session.ts"], categories: ["unit"], severity: "high", failureModes: ["session loss"], evidence: [{ path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }] }],
    reviewedSourcePaths: ["session.ts"], reviewedTestPaths: scenario === "limited" ? [] : ["session.unit.test.ts"], limitations: [] };
  const selection = { selectedGapIds: empty ? [] : ["GAP-session-1"], rejected: [], limitations: [] };
  const plan = structuredClone(f.plan); plan.mode = "testing";
  plan.traceability.requirementLinks.links = [{ requirementId: "GAP-session-1", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  for (const task of plan.tasks) {
    task.addresses.requirements = [scenario === "traceability" ? "missing" : "GAP-session-1"];
    task.scope.likelyFiles = [scenario === "production-write" ? "session.ts" : "session.unit.test.ts"];
    task.readFirst = ["session.ts", "session.unit.test.ts"];
    task.verification.commands = [{ command: scenario === "invented-command" ? "invented test" : "npm run test", expectedExitCode: 0, executionPolicy: "derived_repository_script" }];
  }
  if (scenario === "question") plan.unresolvedQuestions.push({ id: "blocker", question: "Which session behavior?", blocking: true, blastRadius: "high" });
  const responses: unknown[] = [risk, selection, ...(["restart", "metadata-drift"].includes(scenario) ? [new Error("interrupted")] : []), plan];
  if (execute) responses.push({ toolResponse: true }, ...(scenario === "execute-restart" ? [new Error("writer interrupted")] : []), { summary: "Added session assertion", limitations: [] });
  let calls = 0;
  let checks = 0;
  const providerOptions = { credential: () => "fixture-credential", client: { async send() {
    calls += 1; const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("UNEXPECTED_PROVIDER_CALL");
    if ((response as { toolResponse?: boolean }).toolResponse) return { status: 200, headers: {}, body: { output: [{ type: "function_call", call_id: "write", name: "testing_write_file", arguments: JSON.stringify({ path: "session.unit.test.ts", expectedHash: createHash("sha256").update("test('unrelated', () => {});\n").digest("hex"), content: "test('session', () => { expect(version).toBe(1); });\n" }) }], usage: { input_tokens: 20, output_tokens: 30 } } };
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(response), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } };
  return { root, config, calls: () => calls, checks: () => checks, core: () => new Orchestrator({ repository: root, providerOptions, testSandbox: { async recover() {}, async run(_snapshot, policy, check) {
    checks += 1;
    return { driver: "docker", image: policy.image, checkId: check.id, isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true, exitCode: scenario === "execute-failed" ? 1 : 0, stdout: "fixture verification", stderr: "" };
  } } }) };
}

it.each(["execute-complete", "execute-failed", "execute-restart"])("runs the guarded public Testing workflow: %s", async (scenario) => {
  const f = await fixture(scenario); let core = f.core(); let result: { runId: string; state: string } = await core.run(f.config);
  if (scenario === "execute-restart") {
    expect(result.state).toBe("FAILED"); core = f.core(); await core.resume(result.runId); result = await core.wait(result.runId);
  }
  expect(result.state).toBe("COMPLETED");
  expect(await core.gate(result.runId)).toMatchObject({ gateStatus: scenario === "execute-failed" ? "failed" : "passed" });
  expect(await core.summary(result.runId)).toMatchObject({ outcome: { testsExecuted: false }, execution: { passed: scenario !== "execute-failed" } });
  expect(f.checks()).toBe(scenario === "execute-failed" ? 1 : 2);
  expect(await readFile(join(f.root, "session.unit.test.ts"), "utf8")).toBe("test('unrelated', () => {});\n");
  const artifacts = await core.artifacts(result.runId);
  expect(artifacts.some(({ kind }) => kind === "testing-execution-completion")).toBe(scenario !== "execute-failed");
  const workspace = artifacts.find(({ kind }) => kind === "testing-workspace");
  if (workspace !== undefined) {
    const artifact = await core.artifact(result.runId, workspace.artifactId) as { content: string };
    const record = JSON.parse(artifact.content) as { handle?: TestingWorktreeHandle };
    if (record.handle !== undefined) await TestingWorktree.recover(record.handle);
  }
});

it("reports no selected gaps without claiming execution in execute mode", async () => {
  const f = await fixture("execute-empty"); const core = f.core(); const result = await core.run(f.config);
  expect(result.state).toBe("COMPLETED"); expect(f.calls()).toBe(2); expect(f.checks()).toBe(0);
  expect(await core.gate(result.runId)).toEqual({ gateStatus: "passed", reasons: [] });
  expect(await core.summary(result.runId)).toMatchObject({ outcome: { selectedGaps: 0, testsExecuted: false }, execution: null });
  expect((await core.artifacts(result.runId)).some(({ kind }) => kind === "testing-workspace")).toBe(false);
});

it.each(["complete", "restart", "empty"])("publishes a read-only public Testing result: %s", async (scenario) => {
  const f = await fixture(scenario); let core = f.core();
  expect(await core.estimate(f.config)).toMatchObject({ estimate: { auditors: 0, files: 3 } });
  let result: { runId: string; state: string } = await core.run(f.config);
  if (scenario === "restart") { expect(result.state).toBe("FAILED"); core = f.core(); await core.resume(result.runId); result = await core.wait(result.runId); }
  expect(result.state).toBe("COMPLETED");
  expect(await core.gate(result.runId)).toEqual({ gateStatus: "passed", reasons: [] });
  expect(await core.summary(result.runId)).toMatchObject({ mode: "testing", outcome: { passed: true, testsExecuted: false, selectedGaps: scenario === "empty" ? 0 : 1 } });
  expect(f.calls()).toBe(scenario === "restart" ? 4 : scenario === "empty" ? 2 : 3);
  const handoff = (await core.artifacts(result.runId)).find(({ kind }) => kind === "implementation");
  if (scenario === "empty") expect(handoff).toBeUndefined();
  else {
    if (handoff === undefined) throw new Error("HANDOFF_ABSENT");
    const artifact = await core.artifact(result.runId, handoff.artifactId) as { content: string };
    const tree = JSON.parse(artifact.content) as Record<string, string>;
    expect(JSON.parse(tree["manifest.json"] ?? "{}")).toMatchObject({ run: { mode: "testing" }, planIR: { mode: "testing" } });
    expect(tree["context/requirements.md"]).toContain("GAP-session-1");
  }
  expect(await readFile(join(f.root, "session.ts"), "utf8")).toBe("export const version = 1;\n");
  expect(await f.core().gate(result.runId)).toEqual({ gateStatus: "passed", reasons: [] });
  await expect(core.replay(result.runId, { consensusPolicy: "full", maximumRounds: 1, criticEnabled: true })).rejects.toThrow("TESTING_AUDIT_REPLAY_NOT_SUPPORTED");
});

it.each(["limited", "no-command", "question", "production-write", "invented-command", "traceability"])("withholds Testing handoff for %s", async (scenario) => {
  const f = await fixture(scenario); const core = f.core(); const result = await core.run(f.config);
  expect(result.state).toBe(["production-write", "invented-command", "traceability"].includes(scenario) ? "FAILED" : "COMPLETED");
  expect(await core.gate(result.runId)).toMatchObject({ gateStatus: "failed" });
  expect((await core.artifacts(result.runId)).some(({ kind }) => kind === "implementation")).toBe(false);
  if (["limited", "no-command"].includes(scenario)) expect(f.calls()).toBe(2);
});

it("rejects resumed planning after command metadata changes", async () => {
  const f = await fixture("metadata-drift"); const core = f.core(); const result = await core.run(f.config);
  expect(result.state).toBe("FAILED");
  await writeFile(join(f.root, "package.json"), '{"scripts":{"test":"different-command"}}');
  await expect(f.core().resume(result.runId)).rejects.toThrow("RUN_REPOSITORY_CHANGED");
  expect(f.calls()).toBe(3);
});

it("uses the CLI configuration path and rejects incompatible presets", async () => {
  const f = await fixture(); const core = f.core();
  const path = join(f.root, "config.json"); await writeFile(path, JSON.stringify(f.config));
  const result = await orchestratorCore(core).run(path);
  expect(result.value).toMatchObject({ state: "COMPLETED" });
  await expect(core.estimate(runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, preset: "feature-simple" } }))).rejects.toThrow("WORKFLOW_PRESET_MODE_MISMATCH");
});
