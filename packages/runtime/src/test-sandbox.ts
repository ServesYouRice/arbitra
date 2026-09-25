import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { verificationExecutionSchema, type VerificationExecution, type VerificationCheck } from "@arbitra/schemas/verification-execution.js";
import type { RepositorySnapshot } from "./repository.js";

export interface BoundedProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stopped: "timeout" | "output_limit" | "cancelled" | "spawn_error" | null;
}
export interface ProcessRequest {
  readonly executable: string; readonly arguments: readonly string[];
  readonly cwd: string; readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number; readonly maximumOutputBytes: number; readonly signal: AbortSignal;
}
export interface ProcessPort { run(request: ProcessRequest): Promise<BoundedProcessResult> }
export interface SandboxTestResult extends BoundedProcessResult {
  readonly driver: "docker"; readonly image: string; readonly checkId: string;
  readonly isolation: "read_only_snapshot_no_network";
  readonly status: "exited" | "interrupted" | "unavailable";
  readonly cleanupCompleted: boolean;
}
export interface SandboxRecoveryHandle { readonly container: string; readonly directory: string }
export interface SandboxLifecycle {
  /** Must durably commit before resolving; no container is launched before this callback. */
  prepared(handle: SandboxRecoveryHandle): Promise<void>;
}
export interface TestSandbox {
  run(snapshot: RepositorySnapshot, execution: VerificationExecution, check: VerificationCheck, signal: AbortSignal, lifecycle?: SandboxLifecycle): Promise<SandboxTestResult>;
  recover(handle: SandboxRecoveryHandle): Promise<void>;
  /** Optional preflight: report engine and local image presence without pulling or building. */
  inspect?(image: string, signal: AbortSignal): Promise<SandboxAvailability>;
}
export interface SandboxAvailability {
  readonly engine: "available" | "unavailable";
  readonly image: "present" | "absent" | "unknown";
  readonly detail: string | null;
}

/** Launch only a local Docker CLI. Container argv is never interpreted by a host shell. */
export class DockerTestSandbox implements TestSandbox {
  constructor(private readonly processes: ProcessPort = { run: runBoundedProcess }) {}

  async recover(handle: SandboxRecoveryHandle): Promise<void> {
    await validateRecoveryHandle(handle);
    const temporary = await mkdtemp(join(tmpdir(), "arbitra-recovery-"));
    try {
      const cleanup = await this.processes.run({ executable: "docker", arguments: ["--config", temporary, "rm", "--force", "--volumes", handle.container], cwd: temporary, environment: dockerEnvironment(), timeoutMs: 10_000, maximumOutputBytes: 4096, signal: new AbortController().signal });
      if (cleanup.stopped !== null || cleanup.exitCode !== 0 && !/No such container:/u.test(cleanup.stderr)) throw new Error(`VERIFICATION_CONTAINER_CLEANUP_FAILED:${handle.container}`);
      await validateRecoveryHandle(handle);
      await rm(handle.directory, { recursive: true, force: true });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async inspect(image: string, signal: AbortSignal): Promise<SandboxAvailability> {
    const execution = verificationExecutionSchema.parse({ driver: "docker", image, checks: [] });
    const temporary = await mkdtemp(join(tmpdir(), "arbitra-preflight-"));
    try {
      const run = (args: readonly string[]) => this.processes.run({ executable: "docker", arguments: ["--config", temporary, ...args], cwd: temporary, environment: dockerEnvironment(), timeoutMs: 5_000, maximumOutputBytes: 4096, signal });
      const info = await run(["info", "--format", "{{.OSType}}"]);
      if (info.stopped !== null || info.exitCode !== 0 || info.stdout.trim() !== "linux") {
        const detail = info.stopped === "spawn_error" ? "docker executable not found on PATH" : info.stopped !== null ? `docker info stopped: ${info.stopped}` : info.exitCode !== 0 ? firstLine(info.stderr) ?? `docker info exited ${String(info.exitCode)}` : `engine OSType is ${info.stdout.trim() || "unknown"}, not linux`;
        return { engine: "unavailable", image: "unknown", detail };
      }
      // `image inspect` reads only the local image store; it never contacts a registry.
      const inspected = await run(["image", "inspect", "--format", "{{.Id}}", execution.image]);
      if (inspected.stopped !== null) return { engine: "available", image: "unknown", detail: `docker image inspect stopped: ${inspected.stopped}` };
      return inspected.exitCode === 0 ? { engine: "available", image: "present", detail: null } : { engine: "available", image: "absent", detail: firstLine(inspected.stderr) };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async run(snapshot: RepositorySnapshot, policy: VerificationExecution, selected: VerificationCheck, signal: AbortSignal, lifecycle?: SandboxLifecycle): Promise<SandboxTestResult> {
    const execution = verificationExecutionSchema.parse(policy);
    const check = execution.checks.find(({ id }) => id === selected.id);
    if (check === undefined || check.executable !== selected.executable || JSON.stringify(check.arguments) !== JSON.stringify(selected.arguments) || JSON.stringify(check.sourcePaths) !== JSON.stringify(selected.sourcePaths)) throw new Error("VERIFICATION_CHECK_NOT_ALLOWLISTED");
    if (signal.aborted) throw new Error("VERIFICATION_CANCELLED");
    validateSnapshot(snapshot);
    const paths = new Set(snapshot.files.map(({ path }) => path));
    if (check.sourcePaths.some((path) => !paths.has(path))) throw new Error("VERIFICATION_CHECK_OUTSIDE_SNAPSHOT");
    // arbitra-determinism: allow -- disposable container identity is minted at the execution boundary
    const container = `arbitra-verification-${randomUUID()}`;
    const root = await mkdtemp(join(tmpdir(), `${container}-`));
    const workspace = join(root, "snapshot"); const configuration = join(root, "docker-config");
    const environment = dockerEnvironment();
    const run = (args: readonly string[], timeoutMs: number, commandSignal: AbortSignal) => this.processes.run({ executable: "docker", arguments: ["--config", configuration, ...args], cwd: root, environment, timeoutMs, maximumOutputBytes: execution.maximumOutputBytes, signal: commandSignal });
    const result = (process: BoundedProcessResult, status: SandboxTestResult["status"], cleanupCompleted: boolean): SandboxTestResult => ({ ...process, status, cleanupCompleted, driver: "docker", image: execution.image, checkId: check.id, isolation: "read_only_snapshot_no_network" });
    let attempted = false;
    const cleanupResources = async () => {
      if (attempted) {
        const cleanup = await run(["rm", "--force", "--volumes", container], 10_000, new AbortController().signal);
        if (cleanup.stopped !== null || cleanup.exitCode !== 0 && !/No such container:/u.test(cleanup.stderr)) throw new Error(`VERIFICATION_CONTAINER_CLEANUP_FAILED:${container}`);
      }
      const child = relative(resolve(tmpdir()), resolve(root));
      if (child.startsWith("..") || isAbsolute(child) || !child.startsWith("arbitra-verification-")) throw new Error("UNSAFE_VERIFICATION_CLEANUP_PATH");
      await rm(root, { recursive: true, force: true });
    };
    try {
      await lifecycle?.prepared({ container, directory: root });
      await mkdir(configuration);
      // Empty CLI configuration and a stripped environment exclude remote contexts,
      // registries and operator credentials. No image is pulled or built here.
      const info = await run(["info", "--format", "{{.OSType}}"], Math.min(execution.timeoutMs, 5_000), signal);
      if (info.stopped !== null || info.exitCode !== 0 || info.stdout.trim() !== "linux") return result(info, "unavailable", true);
      await mkdir(workspace, { mode: 0o755 }); await chmod(workspace, 0o755);
      for (const file of snapshot.files) {
        const destination = join(workspace, file.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
        await writeFile(destination, file.lines.join("\n"), { encoding: "utf8", flag: "wx", mode: 0o444 });
      }
      if (signal.aborted) throw new Error("VERIFICATION_CANCELLED");
      attempted = true;
      const process = await run(dockerTestArguments(execution, check, workspace, container), execution.timeoutMs, signal);
      // Killing an attached CLI does not establish that its container stopped.
      // Force removal is independently bounded and must succeed before continuing.
      const cleanup = await run(["rm", "--force", "--volumes", container], 10_000, new AbortController().signal);
      const cleanupCompleted = cleanup.stopped === null && (cleanup.exitCode === 0 || /No such container:/u.test(cleanup.stderr));
      attempted = !cleanupCompleted;
      if (!cleanupCompleted) throw new Error(`VERIFICATION_CONTAINER_CLEANUP_FAILED:${container}`);
      return result(process, process.stopped === null ? "exited" : "interrupted", true);
    } finally {
      await cleanupResources();
    }
  }
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.length > 0);
  return line === undefined ? null : line.slice(0, 300);
}

function dockerEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]]));
}

async function validateRecoveryHandle(handle: SandboxRecoveryHandle): Promise<void> {
  if (!/^arbitra-verification-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(handle.container)
    || !isAbsolute(handle.directory) || resolve(dirname(handle.directory)) !== resolve(tmpdir())
    || !basename(handle.directory).startsWith(`${handle.container}-`)
    || !/^[A-Za-z0-9]{6}$/u.test(basename(handle.directory).slice(handle.container.length + 1))) throw new Error("INVALID_VERIFICATION_RECOVERY_HANDLE");
  try {
    const entry = await lstat(handle.directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || dirname(await realpath(handle.directory)) !== await realpath(tmpdir())) throw new Error("UNSAFE_VERIFICATION_RECOVERY_PATH");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function dockerTestArguments(execution: VerificationExecution, check: VerificationCheck, workspace: string, container: string): readonly string[] {
  if (!isAbsolute(workspace) || /[,\r\n\0]/u.test(workspace)) throw new Error("INVALID_VERIFICATION_MOUNT_PATH");
  return ["run", "--pull=never", "--name", container, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534", "--pids-limit=64", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--ipc=none", "--log-driver=none", "--tmpfs=/tmp:rw,noexec,nosuid,size=64m", "--mount", `type=bind,source=${workspace},target=/workspace,readonly`, "--workdir=/workspace", "--entrypoint", check.executable, execution.image, ...check.arguments];
}

function validateSnapshot(snapshot: RepositorySnapshot): void {
  const paths = new Set<string>(); let bytes = 0;
  for (const file of snapshot.files) {
    if (file.path.includes("\\") || file.path.includes(":") || file.path.startsWith("/") || /[\0\r\n]/u.test(file.path) || file.path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("INVALID_VERIFICATION_SOURCE_PATH");
    if (paths.has(file.path)) throw new Error("DUPLICATE_VERIFICATION_SOURCE_PATH");
    paths.add(file.path); bytes += Buffer.byteLength(file.lines.join("\n"));
    if (bytes > 32 * 1024 * 1024) throw new Error("VERIFICATION_SNAPSHOT_SIZE_LIMIT");
  }
}

export function runBoundedProcess(request: ProcessRequest): Promise<BoundedProcessResult> {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes < 1) throw new Error("INVALID_PROCESS_BOUND");
  if (request.signal.aborted) return Promise.resolve({ exitCode: null, stdout: "", stderr: "", stopped: "cancelled" });
  return new Promise((resolveResult) => {
    const process = spawn(request.executable, [...request.arguments], { cwd: request.cwd, env: { ...request.environment }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stopped: BoundedProcessResult["stopped"] = null; let bytes = 0;
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const stop = (reason: Exclude<BoundedProcessResult["stopped"], null>) => { if (stopped === null) stopped = reason; process.kill("SIGKILL"); };
    const append = (target: Buffer[], chunk: Buffer) => {
      const available = Math.max(0, request.maximumOutputBytes - bytes);
      if (available > 0) target.push(Buffer.from(chunk.subarray(0, available)));
      bytes += Math.min(chunk.length, available);
      if (chunk.length > available) stop("output_limit");
    };
    process.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    process.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    const cancelled = () => stop("cancelled");
    request.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
    process.on("error", () => { stopped = "spawn_error"; });
    process.on("close", (exitCode) => {
      clearTimeout(timer); request.signal.removeEventListener("abort", cancelled);
      const out = boundedUtf8(Buffer.concat(stdout)); const err = boundedUtf8(Buffer.concat(stderr));
      resolveResult({ exitCode, stdout: out.text, stderr: err.text, stopped: stopped ?? (out.truncated || err.truncated ? "output_limit" : null) });
    });
    if (request.signal.aborted) cancelled();
  });
}

/** Replacement characters from malformed or cut UTF-8 must not expand the byte cap. */
function boundedUtf8(buffer: Buffer): { text: string; truncated: boolean } {
  const decoded = buffer.toString("utf8");
  if (Buffer.byteLength(decoded) <= buffer.length) return { text: decoded, truncated: false };
  const characters: string[] = []; let bytes = 0;
  for (const character of decoded) {
    bytes += Buffer.byteLength(character);
    if (bytes > buffer.length) break;
    characters.push(character);
  }
  return { text: characters.join(""), truncated: true };
}
