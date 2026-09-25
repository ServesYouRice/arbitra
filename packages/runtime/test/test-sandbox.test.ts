import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verificationExecutionSchema } from "@arbitra/schemas/verification-execution.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { DockerTestSandbox, resolveLocalDockerEndpoint, runBoundedProcess, type ProcessRequest, type BoundedProcessResult, type SandboxRecoveryHandle } from "../src/test-sandbox.js";

const policy = () => verificationExecutionSchema.parse({ driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, checks: [{ id: "guard", sourcePaths: ["test.js"], executable: "/usr/local/bin/node", arguments: ["--test", "test.js"] }] });
const snapshot = { root: "unused-original-repository", files: [{ path: "test.js", lines: ["console.log('snapshot source');"], byteLength: 31, lineStartBytes: [0] }] };
const ok = (stdout = ""): BoundedProcessResult => ({ stdout, stderr: "", exitCode: 0, stopped: null });
function selected() { const check = policy().checks[0]; if (check === undefined) throw new Error("CHECK_ABSENT"); return check; }

describe("bounded isolated verification execution", () => {
  it("persists resource identity before dispatch and recovers failed cleanup with a fresh adapter", async () => {
    let handle: SandboxRecoveryHandle | undefined;
    const sandbox = new DockerTestSandbox({ async run(request) {
      expect(handle).toBeDefined();
      if (request.arguments[2] === "info") return ok("linux");
      if (request.arguments[2] === "run") return ok();
      return { ...ok(), exitCode: 1 };
    } });
    await expect(sandbox.run(snapshot, policy(), selected(), new AbortController().signal, { async prepared(value) { handle = value; } })).rejects.toThrow("VERIFICATION_CONTAINER_CLEANUP_FAILED");
    if (handle === undefined) throw new Error("HANDLE_ABSENT");
    expect((await stat(handle.directory)).isDirectory()).toBe(true);
    const saved = handle;
    const recovery = new DockerTestSandbox({ async run(request) {
      expect(request.arguments.slice(2)).toEqual(["rm", "--force", "--volumes", saved.container]);
      expect(request.cwd).not.toBe(saved.directory);
      expect(request.signal.aborted).toBe(false);
      return ok();
    } });
    await recovery.recover(saved);
    await expect(stat(saved.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await recovery.recover(saved);
  });

  it("does not dispatch when durable resource registration fails", async () => {
    let directory = "";
    const sandbox = new DockerTestSandbox({ async run() { throw new Error("UNEXPECTED_EXECUTION"); } });
    await expect(sandbox.run(snapshot, policy(), selected(), new AbortController().signal, { async prepared(handle) { directory = handle.directory; throw new Error("DISK_FULL"); } })).rejects.toThrow("DISK_FULL");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sandbox.recover({ container: "unrelated", directory: tmpdir() })).rejects.toThrow("INVALID_VERIFICATION_RECOVERY_HANDLE");
    await expect(sandbox.recover({ container: "arbitra-verification-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", directory: tmpdir() })).rejects.toThrow("INVALID_VERIFICATION_RECOVERY_HANDLE");
  });

  it("mounts only snapshot bytes and launches pinned container argv without host credentials or network", async () => {
    const calls: ProcessRequest[] = [];
    const sandbox = new DockerTestSandbox({ async run(request) {
      calls.push(request);
      if (request.arguments[2] === "info") return ok("linux\n");
      if (request.arguments[2] === "run") {
        expect(await readFile(join(request.cwd, "snapshot", "test.js"), "utf8")).toBe(snapshot.files[0]?.lines.join("\n"));
        expect(request.arguments).toEqual(expect.arrayContaining(["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534", "--pids-limit=64", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--log-driver=none", "--entrypoint", "/usr/local/bin/node", policy().image]));
        expect(request.arguments).toContain(`type=bind,source=${join(request.cwd, "snapshot")},target=/workspace,readonly`);
        expect(request.environment).not.toHaveProperty("DOCKER_HOST"); expect(request.environment).not.toHaveProperty("HOME");
        expect(request.arguments.join(" ")).not.toContain(snapshot.root);
        return { ...ok("test result"), exitCode: 1 };
      }
      expect(request.arguments.slice(2, 5)).toEqual(["rm", "--force", "--volumes"]);
      return ok();
    } });
    const result = await sandbox.run(snapshot, policy(), selected(), new AbortController().signal);
    expect(result).toMatchObject({ exitCode: 1, stdout: "test result", status: "exited", cleanupCompleted: true });
    expect(calls.map(({ arguments: args }) => args[2])).toEqual(["info", "run", "rm"]);
    await expect(stat(calls[0]?.cwd ?? "missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["timeout", "output_limit", "cancelled"] as const)("removes the container independently after %s", async (stopped) => {
    const controller = new AbortController(); let cleaned = false;
    const sandbox = new DockerTestSandbox({ async run(request) {
      if (request.arguments[2] === "info") return ok("linux");
      if (request.arguments[2] === "run") { controller.abort(); return { ...ok(), exitCode: null, stopped }; }
      expect(request.signal.aborted).toBe(false); cleaned = true; return ok();
    } });
    expect(await sandbox.run(snapshot, policy(), selected(), controller.signal)).toMatchObject({ status: "interrupted", stopped, cleanupCompleted: true });
    expect(cleaned).toBe(true);
  });

  it("does not create a container when the engine is absent or not Linux", async () => {
    for (const response of [{ ...ok(), exitCode: 1 }, ok("windows")]) {
      const calls: string[] = [];
      const sandbox = new DockerTestSandbox({ async run(request) { calls.push(request.arguments[2] ?? ""); return response; } });
      expect(await sandbox.run(snapshot, policy(), selected(), new AbortController().signal)).toMatchObject({ status: "unavailable", cleanupCompleted: true });
      expect(calls).toEqual(["info"]);
    }
  });

  it("rejects unapproved command changes and out-of-snapshot paths before executing anything", async () => {
    const sandbox = new DockerTestSandbox({ async run() { throw new Error("UNEXPECTED_EXECUTION"); } });
    await expect(sandbox.run(snapshot, policy(), { ...selected(), arguments: ["other.js"] }, new AbortController().signal)).rejects.toThrow("VERIFICATION_CHECK_NOT_ALLOWLISTED");
    await expect(sandbox.run({ ...snapshot, files: [] }, policy(), selected(), new AbortController().signal)).rejects.toThrow("VERIFICATION_CHECK_OUTSIDE_SNAPSHOT");
    await expect(sandbox.run({ ...snapshot, files: [{ ...snapshot.files[0], path: "../outside.js", lines: [""], byteLength: 0, lineStartBytes: [0] }] }, policy(), selected(), new AbortController().signal)).rejects.toThrow("INVALID_VERIFICATION_SOURCE_PATH");
  });

  it("requires pinned images, unique checks and bounded policy values", () => {
    expect(() => verificationExecutionSchema.parse({ ...policy(), image: "node:latest" })).toThrow();
    expect(() => verificationExecutionSchema.parse({ ...policy(), checks: [selected(), selected()] })).toThrow();
    expect(() => verificationExecutionSchema.parse({ ...policy(), timeoutMs: 0 })).toThrow();
    expect(() => verificationExecutionSchema.parse({ ...policy(), maximumRuns: 51 })).toThrow();
  });

  it("validates structured execution configuration", () => {
    expect(runConfigSchema.shape.verification.safeParse({ execution: policy() }).success).toBe(true);
    expect(runConfigSchema.shape.verification.safeParse({ execution: { ...policy(), image: "node:latest" } }).success).toBe(false);
    expect(runConfigSchema.shape.verification.safeParse({ maxModelQuestionsPerRound: 4 }).success).toBe(true);
  });

  it("retries failed cleanup and reports failure even if the retry succeeds", async () => {
    let removals = 0; let directory = "";
    const sandbox = new DockerTestSandbox({ async run(request) {
      directory = request.cwd;
      if (request.arguments[2] === "info") return ok("linux");
      if (request.arguments[2] === "run") return ok();
      removals += 1;
      return removals === 1 ? { ...ok(), exitCode: 1, stderr: "engine temporarily unavailable" } : ok();
    } });
    await expect(sandbox.run(snapshot, policy(), selected(), new AbortController().signal)).rejects.toThrow("VERIFICATION_CONTAINER_CLEANUP_FAILED");
    expect(removals).toBe(2);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("engine refusals", () => {
  it.each([
    [125, "docker: Error response from daemon: No such image: local/node@sha256:aaaa", "unavailable"],
    [127, "docker: Error response from daemon: failed to create task for container: exec: \"/usr/local/bin/node\": stat /usr/local/bin/node: no such file or directory", "unavailable"],
    [125, "test runner exited with 125", "exited"],
    [1, "docker: looks like engine text but the check failed", "exited"],
  ] as const)("classifies exit %i with %j as %s", async (exitCode, stderr, status) => {
    const sandbox = new DockerTestSandbox({ async run(request) {
      if (request.arguments[2] === "info") return ok("linux");
      if (request.arguments[2] === "run") return { ...ok(), exitCode, stderr };
      return ok();
    } });
    expect(await sandbox.run(snapshot, policy(), selected(), new AbortController().signal)).toMatchObject({ status, exitCode, cleanupCompleted: true });
  });
});

describe("local Docker endpoint resolution", () => {
  const never: { run(request: ProcessRequest): Promise<BoundedProcessResult> } = { async run() { throw new Error("UNEXPECTED_LOOKUP"); } };
  const signal = new AbortController().signal;

  it("uses only a local DOCKER_HOST and refuses remote engines", async () => {
    expect(await resolveLocalDockerEndpoint({ DOCKER_HOST: "unix:///Users/me/.docker/run/docker.sock" }, never, signal)).toEqual({ host: "unix:///Users/me/.docker/run/docker.sock" });
    expect(await resolveLocalDockerEndpoint({ DOCKER_HOST: "npipe:////./pipe/docker_engine" }, never, signal)).toEqual({ host: "npipe:////./pipe/docker_engine" });
    for (const remote of ["tcp://10.0.0.5:2376", "ssh://user@build-host"]) {
      const endpoint = await resolveLocalDockerEndpoint({ DOCKER_HOST: remote }, never, signal);
      expect(endpoint).toMatchObject({ unavailable: expect.stringContaining("not a local socket") });
      expect(JSON.stringify(endpoint)).not.toContain("10.0.0.5"); expect(JSON.stringify(endpoint)).not.toContain("build-host");
    }
  });

  it("reads the current context's endpoint without the rest of the operator environment", async () => {
    const calls: ProcessRequest[] = [];
    const lookup = (result: BoundedProcessResult) => ({ async run(request: ProcessRequest) { calls.push(request); return result; } });
    expect(await resolveLocalDockerEndpoint({ HOME: "/Users/me", PATH: "/bin", AWS_SECRET_ACCESS_KEY: "secret" }, lookup(ok("unix:///Users/me/.docker/run/docker.sock\n")), signal)).toEqual({ host: "unix:///Users/me/.docker/run/docker.sock" });
    expect(calls[0]?.arguments).toEqual(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    expect(calls[0]?.environment).toEqual({ HOME: "/Users/me", PATH: "/bin" });
    expect(await resolveLocalDockerEndpoint({}, lookup({ ...ok(), exitCode: 1, stderr: "context not found" }), signal)).toEqual({ host: null });
    expect(await resolveLocalDockerEndpoint({}, lookup(ok("tcp://remote:2375")), signal)).toMatchObject({ unavailable: expect.stringContaining("Docker context endpoint tcp://…") });
    await expect(resolveLocalDockerEndpoint({}, lookup({ ...ok(), exitCode: null, stopped: "cancelled" }), signal)).rejects.toThrow("VERIFICATION_CANCELLED");
  });

  it("passes the resolved socket to every command and launches nothing for a refused engine", async () => {
    const calls: ProcessRequest[] = [];
    const sandbox = new DockerTestSandbox({ async run(request) {
      calls.push(request);
      expect(request.arguments.slice(2, 4)).toEqual(["--host", "unix:///run/user/1000/docker.sock"]);
      return request.arguments[4] === "info" ? ok("linux") : ok();
    } }, async () => ({ host: "unix:///run/user/1000/docker.sock" }));
    expect(await sandbox.run(snapshot, policy(), selected(), new AbortController().signal)).toMatchObject({ status: "exited", cleanupCompleted: true });
    expect(calls.map(({ arguments: args }) => args[4])).toEqual(["info", "run", "rm"]);
    const refused = new DockerTestSandbox(never, async () => ({ unavailable: "DOCKER_HOST tcp://… is not a local socket" }));
    expect(await refused.run(snapshot, policy(), selected(), new AbortController().signal)).toMatchObject({ status: "unavailable", stderr: expect.stringContaining("not a local socket") });
    expect(await refused.inspect(policy().image, new AbortController().signal)).toEqual({ engine: "unavailable", image: "unknown", detail: "DOCKER_HOST tcp://… is not a local socket" });
  });
});

describe("native process bounds", () => {
  const request = (source: string): ProcessRequest => ({ executable: process.execPath, arguments: ["-e", source], cwd: tmpdir(), environment: {}, timeoutMs: 5_000, maximumOutputBytes: 256, signal: new AbortController().signal });
  it("captures real process exit and streams", async () => {
    expect(await runBoundedProcess(request("process.stdout.write('out');process.stderr.write('err');process.exitCode=3"))).toEqual({ exitCode: 3, stdout: "out", stderr: "err", stopped: null });
  });
  it("kills an overflowing process and bounds combined output", async () => {
    const result = await runBoundedProcess(request("process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"));
    expect(result.stopped).toBe("output_limit"); expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(256);
  });
  it.each(["Buffer.alloc(256,255)", "Buffer.from('😀'.repeat(100))"])("bounds decoded UTF-8 output for %s", async (expression) => {
    const result = await runBoundedProcess({ ...request(`process.stdout.write(${expression})`), maximumOutputBytes: 255 });
    expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(255);
    expect(result.stopped).toBe("output_limit");
    expect(result.stdout).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
  it("enforces timeout and pre-dispatch cancellation", async () => {
    expect((await runBoundedProcess({ ...request("setInterval(()=>{},1000)"), timeoutMs: 100 })).stopped).toBe("timeout");
    expect((await runBoundedProcess({ ...request("throw new Error('must not run')"), signal: AbortSignal.abort() })).stopped).toBe("cancelled");
  });
});
