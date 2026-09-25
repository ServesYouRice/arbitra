import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { featureFixture } from "./feature-fixture.js";
import { Orchestrator } from "../src/orchestrator.js";
import { RunStore } from "../src/run-store.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";

/** Byte-level identity of a whole run directory: every path and every byte. */
export async function runDigest(root: string, runId: string): Promise<string> {
  const directory = join(root, ".runs", "runs", runId);
  const hash = createHash("sha256");
  const walk = async (path: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, `${relative}${entry.name}/`);
      else hash.update(`${relative}${entry.name}\0`).update(await readFile(child)).update("\0");
    }
  };
  await walk(directory, "");
  return hash.digest("hex");
}

/** The Testing workflow over an ordered fake provider whose queue a test can extend. */
export async function testingReplayFixture(root: string, options: { readonly execute?: boolean } = {}) {
  const f = await featureFixture(root);
  const authorization = { maximumParallelTasks: 1, partitions: [{ id: "tests", paths: ["session.unit.test.ts"] }], tasks: [{ taskId: "TASK-001", partitionId: "tests", exclusive: false }] };
  const execution = { authorization,
    verification: { execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, maximumRuns: 4, checks: [{ id: "tests", executable: "/usr/bin/npm", arguments: ["run", "test"], sourcePaths: ["session.unit.test.ts"] }] },
      bindings: [{ command: "npm run test", checkId: "tests", expectedExitCode: 0, authorization: "repository_script" }] },
    models: { fast: "planner", balanced: "planner", frontier: "planner" }, maximumAttempts: 1 };
  await writeFile(join(root, "session.unit.test.ts"), "test('unrelated', () => {});\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  const execute = options.execute ?? true;
  const config = runConfigSchema.parse({ ...f.config, mode: "testing", models: { ...f.config.models, planner: { ...f.config.models["planner"], capabilityTier: "frontier" } }, workflow: {
    preset: execute ? "testing-execute" : "testing-plan", testing: { mode: execute ? "execute" : "plan", ...(execute ? { execution } : {}), goal: "Protect session behavior", roles: { analyst: "planner", planner: "planner" } }, modelExecution: f.config.workflow["modelExecution"],
  } });
  const risk = { summary: "Session coverage", surfaces: [{ id: "session", paths: ["session.ts"], categories: ["unit"], severity: "high", failureModes: ["session loss"], evidence: [{ path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }] }],
    reviewedSourcePaths: ["session.ts"], reviewedTestPaths: ["session.unit.test.ts"], limitations: [] };
  const selection = { selectedGapIds: ["GAP-session-1"], rejected: [], limitations: [] };
  const plan = structuredClone(f.plan); plan.mode = "testing";
  plan.traceability.requirementLinks.links = [{ requirementId: "GAP-session-1", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  for (const task of plan.tasks) {
    task.addresses.requirements = ["GAP-session-1"];
    task.scope.likelyFiles = ["session.unit.test.ts"];
    task.readFirst = ["session.ts", "session.unit.test.ts"];
    task.verification.commands = [{ command: "npm run test", expectedExitCode: 0, executionPolicy: "derived_repository_script" }];
  }
  const writer = [{ toolResponse: true }, { summary: "Added session assertion", limitations: [] }];
  const responses: unknown[] = [risk, selection, plan, ...(execute ? writer : [])];
  const sent: string[] = [];
  let checks = 0;
  const providerOptions = { credential: () => "fixture-credential", client: { async send(request: { body: unknown }) {
    const response = responses.shift();
    sent.push(JSON.stringify(request.body).includes("testing_write_file") ? "writer" : "planning");
    if (response === undefined) throw new Error("UNEXPECTED_PROVIDER_CALL");
    if ((response as { toolResponse?: boolean }).toolResponse) return { status: 200, headers: {}, body: { output: [{ type: "function_call", call_id: "write", name: "testing_write_file", arguments: JSON.stringify({ path: "session.unit.test.ts", expectedHash: createHash("sha256").update("test('unrelated', () => {});\n").digest("hex"), content: "test('session', () => { expect(version).toBe(1); });\n" }) }], usage: { input_tokens: 20, output_tokens: 30 } } };
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(response), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } };
  const orchestrator = () => new Orchestrator({ repository: root, providerOptions, testSandbox: { async recover() {}, async run(_snapshot, policy, check) {
    checks += 1;
    return { driver: "docker", image: policy.image, checkId: check.id, isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true, exitCode: 0, stdout: "fixture verification", stderr: "" };
  } } });
  return { config, authorization, analysis: [risk, selection], plan, writer, responses, sent, checks: () => checks, orchestrator };
}

export type Report = { stages: { stage: string; decision: string; reasons: string[]; reused: { activityId: string; sourceArtifactId?: string }[]; regenerated: { activityId: string; reason?: string }[] }[] };
export async function report(core: Orchestrator, runId: string): Promise<Report> {
  const value = await core.replayReport(runId);
  if (value === null) throw new Error("REPLAY_REPORT_ABSENT");
  return value as unknown as Report;
}
export const stage = (value: Report, name: string) => {
  const found = value.stages.find((item) => item.stage === name);
  if (found === undefined) throw new Error(`STAGE_ABSENT:${name}`);
  return found;
};
export async function budget(root: string, runId: string): Promise<readonly string[]> {
  const store = new RunStore(join(root, ".runs", "runs"), runId);
  const descriptor = (await store.listArtifacts()).find(({ kind }) => kind === "model-token-budget");
  if (descriptor === undefined) return [];
  return (await store.artifacts.get<{ reservations: { activityId: string }[] }>(descriptor.ref)).reservations.map(({ activityId }) => activityId);
}

export async function workspace(core: Orchestrator, runId: string): Promise<string> {
  const artifact = (await core.artifacts(runId)).find(({ kind }) => kind === "testing-workspace");
  if (artifact === undefined) throw new Error("WORKSPACE_ABSENT");
  const record = JSON.parse((await core.artifact(runId, artifact.artifactId) as { content: string }).content) as { handle?: TestingWorktreeHandle };
  if (record.handle === undefined) throw new Error("WORKSPACE_HANDLE_ABSENT");
  return record.handle.directory;
}

export async function cleanup(core: Orchestrator, runId: string): Promise<void> {
  const artifact = (await core.artifacts(runId)).find(({ kind }) => kind === "testing-workspace");
  if (artifact === undefined) return;
  const record = JSON.parse((await core.artifact(runId, artifact.artifactId) as { content: string }).content) as { handle?: TestingWorktreeHandle };
  if (record.handle !== undefined) await TestingWorktree.recover(record.handle);
}
