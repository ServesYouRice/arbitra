import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verificationExecutionSchema, type VerificationExecution } from "@arbitra/schemas/verification-execution.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { orchestratorCore } from "../src/cli-core.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { RepositorySnapshot } from "../src/repository.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";
import { featureFixture } from "./feature-fixture.js";
import { DockerTestSandbox, runBoundedProcess, type ProcessPort, type SandboxRecoveryHandle } from "../src/test-sandbox.js";

/**
 * P04: the Docker boundary against a real local engine. Opt-in, because it needs a running
 * Linux engine and a local image pinned by digest that already contains node and vitest
 * (tooling/sandbox-image). Every case here launches real containers; the injected
 * process-port cases live in test-sandbox.test.ts and are reported separately.
 *
 *   ARBITRA_DOCKER_ACCEPTANCE=1 ARBITRA_DOCKER_IMAGE=arbitra-sandbox-node@sha256:<id> \
 *     pnpm --filter @arbitra/runtime exec vitest run test/docker-sandbox.acceptance.test.ts
 */
const image = process.env["ARBITRA_DOCKER_IMAGE"] ?? "";
const enabled = process.env["ARBITRA_DOCKER_ACCEPTANCE"] === "1" && image !== "";

function snapshot(root: string, files: Record<string, string>): RepositorySnapshot {
  return { root, files: Object.entries(files).map(([path, content]) => ({ path, lines: content.split("\n"), byteLength: Buffer.byteLength(content), lineStartBytes: [0] })) };
}
function policy(checks: { id: string; sourcePaths: string[]; executable: string; arguments: string[] }[], overrides: Partial<VerificationExecution> = {}): VerificationExecution {
  return verificationExecutionSchema.parse({ driver: "docker", image, maximumRuns: 50, timeoutMs: 60_000, ...overrides, checks });
}
function only(execution: VerificationExecution) { const check = execution.checks[0]; if (check === undefined) throw new Error("CHECK_ABSENT"); return check; }
function docker(...args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
const leftovers = () => docker("ps", "--all", "--quiet", "--filter", "name=arbitra-verification-");
async function temporaryVerificationDirectories(): Promise<string[]> { return (await readdir(tmpdir())).filter((name) => name.startsWith("arbitra-verification-")); }

const probe = `
import fs from "node:fs"; import os from "node:os"; import dns from "node:dns/promises"; import net from "node:net";
const attempt = async (action) => { try { await action(); return "allowed"; } catch (error) { return error.code ?? error.message; } };
const read = (path) => { try { return fs.readFileSync(path, "utf8").trim(); } catch (error) { return error.code; } };
const status = read("/proc/self/status");
console.log(JSON.stringify({
  uid: process.getuid(), gid: process.getgid(),
  writeWorkspace: await attempt(() => fs.writeFileSync("/workspace/escape.txt", "x")),
  writeRoot: await attempt(() => fs.writeFileSync("/escape.txt", "x")),
  writeTmp: await attempt(() => fs.writeFileSync("/tmp/scratch.txt", "x")),
  interfaces: Object.keys(os.networkInterfaces()).sort(),
  dns: await attempt(() => dns.lookup("example.com")),
  connect: await attempt(() => new Promise((resolve, reject) => { const socket = net.connect({ host: "1.1.1.1", port: 443 }); socket.setTimeout(3000); socket.on("connect", () => { socket.destroy(); resolve(); }); socket.on("timeout", () => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })); }); socket.on("error", reject); })),
  environment: Object.keys(process.env).sort(),
  capabilities: /CapEff:\\s*(\\w+)/.exec(status)?.[1], noNewPrivileges: /NoNewPrivs:\\s*(\\d)/.exec(status)?.[1],
  memoryMax: read("/sys/fs/cgroup/memory.max"), pidsMax: read("/sys/fs/cgroup/pids.max"), cpuMax: read("/sys/fs/cgroup/cpu.max"),
  dockerSocket: fs.existsSync("/var/run/docker.sock"),
  hostRootVisible: fs.existsSync(process.argv[2]),
  workspace: fs.readdirSync("/workspace").sort(),
}));
`;

describe.skipIf(!enabled)("P04: real Docker sandbox", () => {
  const roots: string[] = [];
  const directory = async () => { const root = await mkdtemp(join(tmpdir(), "p04-source-")); roots.push(root); return root; };
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    expect(leftovers()).toBe("");
  });

  it("reports the engine and the pinned image through the preflight probe, and an absent image as absent", async () => {
    const sandbox = new DockerTestSandbox();
    expect(await sandbox.inspect(image, new AbortController().signal)).toEqual({ engine: "available", image: "present", detail: null });
    expect(await sandbox.inspect(`local/absent@sha256:${"b".repeat(64)}`, new AbortController().signal)).toMatchObject({ engine: "available", image: "absent" });
  });

  it("runs a passing and a failing check in the pinned image and removes both containers", async () => {
    const source = snapshot(await directory(), {
      "package.json": '{"scripts":{"test":"vitest run"}}',
      "sum.ts": "export const sum = (a: number, b: number) => a + b;\n",
      "sum.test.ts": 'import { expect, test } from "vitest";\nimport { sum } from "./sum";\ntest("adds", () => expect(sum(1, 2)).toBe(3));\n',
      "broken.test.ts": 'import { expect, test } from "vitest";\ntest("fails", () => expect(1).toBe(2));\n',
    });
    const execution = policy([
      { id: "passing", sourcePaths: ["sum.test.ts"], executable: "/usr/local/bin/npm", arguments: ["run", "test", "--", "sum.test.ts"] },
      { id: "failing", sourcePaths: ["broken.test.ts"], executable: "/usr/local/bin/npm", arguments: ["run", "test", "--", "broken.test.ts"] },
    ]);
    const sandbox = new DockerTestSandbox();
    const [passing, failing] = execution.checks;
    if (passing === undefined || failing === undefined) throw new Error("CHECKS_ABSENT");
    const passed = await sandbox.run(source, execution, passing, new AbortController().signal);
    expect(passed).toMatchObject({ status: "exited", exitCode: 0, stopped: null, cleanupCompleted: true, image, isolation: "read_only_snapshot_no_network" });
    expect(passed.stdout).toContain("1 passed");
    const failed = await sandbox.run(source, execution, failing, new AbortController().signal);
    expect(failed).toMatchObject({ status: "exited", exitCode: 1, stopped: null, cleanupCompleted: true });
    expect(failed.stdout + failed.stderr).toContain("1 failed");
    expect(leftovers()).toBe("");
  });

  it("isolates the check: read-only snapshot and root, no network, no host credentials, dropped privileges and resource limits", async () => {
    const root = await directory();
    await writeFile(join(root, "probe.mjs"), probe); await writeFile(join(root, "untouched.txt"), "original\n");
    const before = createHash("sha256").update(await readFile(join(root, "probe.mjs"))).update(await readFile(join(root, "untouched.txt"))).digest("hex");
    const execution = policy([{ id: "probe", sourcePaths: ["probe.mjs"], executable: "/usr/local/bin/node", arguments: ["probe.mjs", root] }]);
    process.env["ARBITRA_P04_CANARY_SECRET"] = "must-not-cross";
    try {
      const result = await new DockerTestSandbox().run(snapshot(root, { "probe.mjs": probe, "untouched.txt": "original\n" }), execution, only(execution), new AbortController().signal);
      expect(result).toMatchObject({ status: "exited", exitCode: 0, cleanupCompleted: true });
      const observed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(observed).toMatchObject({ uid: 65534, gid: 65534, writeWorkspace: "EROFS", writeRoot: "EROFS", writeTmp: "allowed", interfaces: ["lo"], capabilities: "0000000000000000", noNewPrivileges: "1",
        memoryMax: String(512 * 1024 * 1024), pidsMax: "64", cpuMax: "100000 100000", dockerSocket: false, hostRootVisible: false, workspace: ["probe.mjs", "untouched.txt"] });
      expect(["EAI_AGAIN", "ENOTFOUND"]).toContain(observed["dns"]);
      expect(["ENETUNREACH", "EHOSTUNREACH", "TIMEOUT"]).toContain(observed["connect"]);
      expect((observed["environment"] as string[]).filter((key) => /SECRET|TOKEN|KEY|ARBITRA|DOCKER|AWS|GITHUB/iu.test(key))).toEqual([]);
    } finally { delete process.env["ARBITRA_P04_CANARY_SECRET"]; }
    const after = createHash("sha256").update(await readFile(join(root, "probe.mjs"))).update(await readFile(join(root, "untouched.txt"))).digest("hex");
    expect(after).toBe(before);
    expect((await readdir(root)).sort()).toEqual(["probe.mjs", "untouched.txt"]);
  });

  it("enforces the memory and process limits inside the container", async () => {
    const source = snapshot(await directory(), {
      "memory.mjs": "const hold = []; for (let i = 0; i < 64; i += 1) hold.push(Buffer.alloc(32 * 1024 * 1024, 1)); console.log('allocated', hold.length);",
      "pids.mjs": "import { spawn } from 'node:child_process'; let failed = 0; const children = []; for (let i = 0; i < 100; i += 1) { try { const child = spawn('/bin/sleep', ['5']); child.on('error', () => { failed += 1; }); children.push(child); } catch { failed += 1; } } setTimeout(() => { console.log(JSON.stringify({ failed })); for (const child of children) child.kill(); }, 1000);",
    });
    const execution = policy([
      { id: "memory", sourcePaths: ["memory.mjs"], executable: "/usr/local/bin/node", arguments: ["--max-old-space-size=4096", "memory.mjs"] },
      { id: "pids", sourcePaths: ["pids.mjs"], executable: "/usr/local/bin/node", arguments: ["pids.mjs"] },
    ]);
    const [memory, pids] = execution.checks;
    if (memory === undefined || pids === undefined) throw new Error("CHECKS_ABSENT");
    const sandbox = new DockerTestSandbox();
    const oom = await sandbox.run(source, execution, memory, new AbortController().signal);
    expect(oom).toMatchObject({ status: "exited", exitCode: 137, cleanupCompleted: true });
    expect(oom.stdout).not.toContain("allocated");
    const forked = await sandbox.run(source, execution, pids, new AbortController().signal);
    expect(forked).toMatchObject({ status: "exited", cleanupCompleted: true });
    expect((JSON.parse(forked.stdout) as { failed: number }).failed).toBeGreaterThan(30);
  });

  it("stops at timeout, cancellation and the output limit, and removes each container", async () => {
    const source = snapshot(await directory(), { "hang.mjs": "setInterval(() => {}, 1000);", "flood.mjs": "process.stdout.write('x'.repeat(200000)); setInterval(() => {}, 1000);" });
    const hang = policy([{ id: "hang", sourcePaths: ["hang.mjs"], executable: "/usr/local/bin/node", arguments: ["hang.mjs"] }], { timeoutMs: 3_000 });
    const sandbox = new DockerTestSandbox();
    const started = Date.now();
    expect(await sandbox.run(source, hang, only(hang), new AbortController().signal)).toMatchObject({ status: "interrupted", stopped: "timeout", cleanupCompleted: true });
    expect(Date.now() - started).toBeLessThan(30_000);
    const controller = new AbortController(); setTimeout(() => controller.abort(), 2_000);
    const long = policy([{ id: "hang", sourcePaths: ["hang.mjs"], executable: "/usr/local/bin/node", arguments: ["hang.mjs"] }]);
    expect(await sandbox.run(source, long, only(long), controller.signal)).toMatchObject({ status: "interrupted", stopped: "cancelled", cleanupCompleted: true });
    const flood = policy([{ id: "flood", sourcePaths: ["flood.mjs"], executable: "/usr/local/bin/node", arguments: ["flood.mjs"] }], { maximumOutputBytes: 4096 });
    const flooded = await sandbox.run(source, flood, only(flood), new AbortController().signal);
    expect(flooded).toMatchObject({ status: "interrupted", stopped: "output_limit", cleanupCompleted: true });
    expect(Buffer.byteLength(flooded.stdout + flooded.stderr)).toBeLessThanOrEqual(4096);
    expect(leftovers()).toBe("");
  });

  it("refuses command-binding drift and records an absent image as unavailable, not as a failed check", async () => {
    const source = snapshot(await directory(), { "a.mjs": "console.log('ran');" });
    const execution = policy([{ id: "a", sourcePaths: ["a.mjs"], executable: "/usr/local/bin/node", arguments: ["a.mjs"] }]);
    const sandbox = new DockerTestSandbox();
    await expect(sandbox.run(source, execution, { ...only(execution), arguments: ["-e", "require('child_process').execSync('id')"] }, new AbortController().signal)).rejects.toThrow("VERIFICATION_CHECK_NOT_ALLOWLISTED");
    await expect(sandbox.run(source, execution, { ...only(execution), executable: "/bin/sh" }, new AbortController().signal)).rejects.toThrow("VERIFICATION_CHECK_NOT_ALLOWLISTED");
    const absent = policy(execution.checks, { image: `local/absent@sha256:${"c".repeat(64)}` });
    const result = await sandbox.run(source, absent, only(absent), new AbortController().signal);
    expect(result).toMatchObject({ status: "unavailable", exitCode: 125, cleanupCompleted: true });
    expect(result.stderr).toContain("No such image");
    const missingExecutable = policy([{ id: "a", sourcePaths: ["a.mjs"], executable: "/usr/local/bin/absent-runner", arguments: [] }]);
    expect(await sandbox.run(source, missingExecutable, only(missingExecutable), new AbortController().signal)).toMatchObject({ status: "unavailable", cleanupCompleted: true });
    expect(leftovers()).toBe("");
  });

  it("recovers a container orphaned by a host process that died mid-check, from a fresh adapter", async () => {
    const source = snapshot(await directory(), { "hang.mjs": "setInterval(() => {}, 1000);" });
    const execution = policy([{ id: "hang", sourcePaths: ["hang.mjs"], executable: "/usr/local/bin/node", arguments: ["hang.mjs"] }]);
    let handle: SandboxRecoveryHandle | undefined;
    let dispatched = false;
    // The dying host: `docker run` really starts, but the host never observes its result
    // or reaches its own cleanup, exactly as after a crash between dispatch and completion.
    const dying: ProcessPort = { run(request) {
      if (request.arguments.includes("run")) { dispatched = true; void runBoundedProcess({ ...request, signal: new AbortController().signal }); return new Promise(() => undefined); }
      return runBoundedProcess(request);
    } };
    void new DockerTestSandbox(dying, async () => ({ host: resolvedHost })).run(source, execution, only(execution), new AbortController().signal, { async prepared(value) { handle = value; } });
    const deadline = Date.now() + 30_000;
    while ((handle === undefined || !dispatched || !docker("ps", "--quiet", "--filter", `name=${handle.container}`)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    if (handle === undefined) throw new Error("HANDLE_ABSENT");
    expect(docker("ps", "--quiet", "--filter", `name=${handle.container}`)).not.toBe("");
    expect((await stat(handle.directory)).isDirectory()).toBe(true);
    const restarted = new DockerTestSandbox();
    await restarted.recover(handle);
    expect(docker("ps", "--all", "--quiet", "--filter", `name=${handle.container}`)).toBe("");
    await expect(stat(handle.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await restarted.recover(handle);
  });

  it("runs parallel writers' checks in distinct containers and cleans up every one", async () => {
    const source = snapshot(await directory(), Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`check-${index}.mjs`, `console.log(JSON.stringify({ index: ${index}, host: (await import('node:os')).hostname() }));`])));
    const execution = policy(Array.from({ length: 4 }, (_, index) => ({ id: `check-${index}`, sourcePaths: [`check-${index}.mjs`], executable: "/usr/local/bin/node", arguments: [`check-${index}.mjs`] })));
    const sandbox = new DockerTestSandbox();
    const before = new Set(await temporaryVerificationDirectories());
    const results = await Promise.all(execution.checks.map((check) => sandbox.run(source, execution, check, new AbortController().signal)));
    expect(results.every(({ status, exitCode, cleanupCompleted }) => status === "exited" && exitCode === 0 && cleanupCompleted)).toBe(true);
    const outputs = results.map(({ stdout }) => JSON.parse(stdout) as { index: number; host: string });
    expect(outputs.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
    expect(new Set(outputs.map(({ host }) => host)).size).toBe(4);
    expect((await temporaryVerificationDirectories()).filter((name) => !before.has(name))).toEqual([]);
    expect(leftovers()).toBe("");
  });
});

// The endpoint the default adapter resolves, reused by the dying host so both see the same engine.
const resolvedHost = enabled ? (() => {
  const configured = process.env["DOCKER_HOST"];
  if (configured !== undefined && configured !== "") return configured;
  const lookup = spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" });
  return lookup.status === 0 && lookup.stdout.trim() !== "" ? lookup.stdout.trim() : null;
})() : null;

/**
 * The public Testing executor with its default (real) sandbox: a scripted model writer adds
 * a vitest test, the task check and the fresh final check run `npm run test` in containers,
 * and the exported change set is applied to a separate matching checkout. The source
 * checkout is never written; a diverged destination rejects application.
 */
describe.skipIf(!enabled)("P04: public Testing execution with real containers", () => {
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); expect(leftovers()).toBe(""); });
  const original = "import { test } from \"vitest\";\ntest('unrelated', () => {});\n";
  const written = (passes: boolean) => `import { expect, test } from "vitest";\nimport { version } from "./session";\ntest("session version", () => expect(version).toBe(${passes ? 1 : 2}));\n`;

  async function fixture(passes: boolean) {
    const root = await mkdtemp(join(tmpdir(), "p04-testing-")); roots.push(root);
    const f = await featureFixture(root);
    await writeFile(join(root, "session.unit.test.ts"), original);
    await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
    const execution = { authorization: { maximumParallelTasks: 1, partitions: [{ id: "tests", paths: ["session.unit.test.ts"] }], tasks: [{ taskId: "TASK-001", partitionId: "tests", exclusive: false }] },
      verification: { execution: { driver: "docker", image, maximumRuns: 4, timeoutMs: 120_000, checks: [{ id: "tests", executable: "/usr/local/bin/npm", arguments: ["run", "test"], sourcePaths: ["session.unit.test.ts"] }] },
        bindings: [{ command: "npm run test", checkId: "tests", expectedExitCode: 0, authorization: "repository_script" }] },
      models: { fast: "planner", balanced: "planner", frontier: "planner" }, maximumAttempts: 1 };
    const config = runConfigSchema.parse({ ...f.config, mode: "testing", models: { ...f.config.models, planner: { ...f.config.models["planner"], capabilityTier: "frontier" } }, workflow: {
      preset: "testing-execute", testing: { mode: "execute", execution, goal: "Protect session behavior", roles: { analyst: "planner", planner: "planner" } }, modelExecution: f.config.workflow["modelExecution"] } });
    const risk = { summary: "Session coverage", surfaces: [{ id: "session", paths: ["session.ts"], categories: ["unit"], severity: "high", failureModes: ["session loss"], evidence: [{ path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }] }],
      reviewedSourcePaths: ["session.ts"], reviewedTestPaths: ["session.unit.test.ts"], limitations: [] };
    const plan = structuredClone(f.plan); plan.mode = "testing";
    plan.traceability.requirementLinks.links = [{ requirementId: "GAP-session-1", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
    for (const task of plan.tasks) {
      task.addresses.requirements = ["GAP-session-1"]; task.scope.likelyFiles = ["session.unit.test.ts"]; task.readFirst = ["session.ts", "session.unit.test.ts"];
      task.verification.commands = [{ command: "npm run test", expectedExitCode: 0, executionPolicy: "derived_repository_script" }];
    }
    const responses: unknown[] = [risk, { selectedGapIds: ["GAP-session-1"], rejected: [], limitations: [] }, plan, { toolResponse: true }, { summary: "Added session assertion", limitations: [] }];
    const providerOptions = { credential: () => "fixture-credential", client: { async send() {
      const response = responses.shift();
      if (response === undefined) throw new Error("UNEXPECTED_PROVIDER_CALL");
      if ((response as { toolResponse?: boolean }).toolResponse) return { status: 200, headers: {}, body: { output: [{ type: "function_call", call_id: "write", name: "testing_write_file",
        arguments: JSON.stringify({ path: "session.unit.test.ts", expectedHash: createHash("sha256").update(original).digest("hex"), content: written(passes) }) }], usage: { input_tokens: 20, output_tokens: 30 } } };
      return { status: 200, headers: {}, body: { output_text: JSON.stringify(response), usage: { input_tokens: 20, output_tokens: 30 } } };
    } } };
    return { root, config, core: () => new Orchestrator({ repository: root, providerOptions }) };
  }
  async function recoverWorktree(core: Orchestrator, runId: string) {
    const workspace = (await core.artifacts(runId)).find(({ kind }) => kind === "testing-workspace");
    if (workspace === undefined) return;
    const record = JSON.parse((await core.artifact(runId, workspace.artifactId) as { content: string }).content) as { handle?: TestingWorktreeHandle };
    if (record.handle !== undefined) await TestingWorktree.recover(record.handle);
  }
  async function checkout(content: string) {
    const root = await mkdtemp(join(tmpdir(), "p04-destination-")); roots.push(root);
    await mkdir(root, { recursive: true }); await writeFile(join(root, "session.unit.test.ts"), content);
    return root;
  }

  it("verifies a model-written test in containers and applies exactly the verified bytes to a matching checkout only", async () => {
    const f = await fixture(true); const core = f.core();
    const result = await core.run(f.config);
    expect(result.state).toBe("COMPLETED");
    expect(await core.gate(result.runId)).toEqual({ gateStatus: "passed", reasons: [] });
    expect(await core.summary(result.runId)).toMatchObject({ execution: { passed: true } });
    const executions = (await core.artifacts(result.runId)).filter(({ kind }) => kind.startsWith("verification-execution-"));
    const records = await Promise.all(executions.map(async ({ artifactId }) => JSON.parse((await core.artifact(result.runId, artifactId) as { content: string }).content) as { state: string; result: { status: string; exitCode: number; image: string; stdout: string } }));
    expect(records.length).toBe(2);
    expect(records.every(({ state, result: value }) => state === "completed" && value.status === "exited" && value.exitCode === 0 && value.image === image && value.stdout.includes("1 passed"))).toBe(true);
    expect(await readFile(join(f.root, "session.unit.test.ts"), "utf8")).toBe(original);
    const verified = await core.testingChangeSet(result.runId);
    expect(verified.changeSet.files).toEqual([{ path: "session.unit.test.ts", expectedHash: createHash("sha256").update(original).digest("hex"), contentHash: createHash("sha256").update(written(true)).digest("hex"), content: written(true) }]);

    const matching = await checkout(original);
    const applied = await orchestratorCore(core).applyChanges(result.runId, matching);
    expect(applied).toMatchObject({ disposition: "passed", value: { applied: [{ path: "session.unit.test.ts", created: false }] } });
    expect(await readFile(join(matching, "session.unit.test.ts"), "utf8")).toBe(written(true));
    const stale = await checkout(`${original}// edited after the run\n`);
    expect(await orchestratorCore(core).applyChanges(result.runId, stale)).toMatchObject({ disposition: "failed", reasons: ["stale_destination"], value: { stale: ["session.unit.test.ts"] } });
    expect(await readFile(join(stale, "session.unit.test.ts"), "utf8")).toBe(`${original}// edited after the run\n`);
    expect(await orchestratorCore(core).applyChanges(result.runId, matching)).toMatchObject({ disposition: "failed", value: { stale: ["session.unit.test.ts"] } });
    await recoverWorktree(core, result.runId);
  });

  it("fails the gate and withholds the handoff when the real check fails", async () => {
    const f = await fixture(false); const core = f.core();
    const result = await core.run(f.config);
    expect(result.state).toBe("COMPLETED");
    expect(await core.gate(result.runId)).toMatchObject({ gateStatus: "failed" });
    expect((await core.artifacts(result.runId)).some(({ kind }) => kind === "testing-execution-completion")).toBe(false);
    await expect(core.testingChangeSet(result.runId)).rejects.toThrow("TESTING_VERIFIED_HANDOFF_ABSENT");
    expect(await readFile(join(f.root, "session.unit.test.ts"), "utf8")).toBe(original);
    await recoverWorktree(core, result.runId);
  });
});
