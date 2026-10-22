import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeProcess, type NativeProcessPort, type NativeProcessResult } from "../../process.js";
import { versionInRange } from "../../semver.js";
import { noUsage, TransportError, type ProviderTransport, type TransportConfiguration, type TransportId, type TransportRequest, type TransportResponse } from "../../transport-contract.js";
import { resetTime } from "./classify.js";
import { CLI_DIALECTS, type CliDialect, type CliInvocationContext } from "./dialects.js";
import { childPath, cliExecutableCandidates, hostNodeExecutable, type CliExecutable, type CliExecutableResolution, type DiscoveryHost, type HostLookup } from "./discovery.js";
import { defaultLimitLedgerPath, fileLimitLedger, type CliLimitLedger } from "./limits.js";
import { interpretCliReply, serializeCliFollowUp, serializeCliPrompt, type CliPrompt } from "./prompt.js";
import type { CliAuthMode, CliTransportSupport } from "./support.js";

export interface CliTransportOptions {
  /** Host environment reader; also used for the executable override and the optional OAuth token. */
  readonly lookup?: HostLookup;
  readonly process?: NativeProcessPort;
  readonly platform?: NodeJS.Platform;
  readonly nodeExecutable?: string;
  readonly temporaryDirectory?: string;
  /** Hard ceiling per call, independent of the runtime's stage timeout. */
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  /** `null` disables the host-local usage-limit record. */
  readonly limits?: CliLimitLedger | null;
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 16 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1_000;

interface CliDirectories { readonly root: string; readonly work: string; readonly control: string; readonly isolatedHome: string; readonly scratch: string }
type CliUsage = TransportResponse["usage"];
/** A CLI session whose model asked for tools, kept for the turn that answers them, with the usage it reported so far. */
interface CliConversation { readonly sessionId: string; readonly boundary: string; readonly directories: CliDirectories; readonly at: number; readonly usage: CliUsage }
/** The CLI a transport runs and the version it reported, with its file's size and modification time then (null: unreadable). */
interface CliResolution { readonly executable: CliExecutable; readonly version: string; readonly stamp: string | null }

/** Host variables a CLI may need to find its login, locale and user identity. Nothing else crosses. */
const PASSTHROUGH = ["USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE"] as const;
const WINDOWS_PASSTHROUGH = ["SystemRoot", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "PATHEXT", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERPROFILE", "ProgramData"] as const;

/**
 * A subscription CLI run as a plain completion engine. Every call gets a fresh temporary
 * root holding an empty working directory, a separate control directory for arbitra's own
 * files, and (for token auth) an isolated home; the environment is rebuilt from an allowlist;
 * the CLI version is checked against the support matrix before first use; the process tree
 * is killed on every exit path; and the root is removed afterwards. The one exception is a conversation that
 * offers tools on a CLI that keeps sessions: while its model waits for tool results, its root and the CLI's session
 * stay for the turn that continues it, and both are removed when the conversation ends, when the run that owns the
 * transport closes it, or after two hours.
 */
export class CliTransport implements ProviderTransport {
  readonly id: TransportId;
  readonly #support: CliTransportSupport;
  readonly #auth: CliAuthMode;
  readonly #oauthTokenEnv: string | null;
  readonly #lookup: HostLookup;
  readonly #process: NativeProcessPort;
  readonly #platform: NodeJS.Platform;
  readonly #node: string;
  readonly #temporary: string | undefined;
  readonly #timeoutMs: number;
  readonly #maximumOutputBytes: number;
  readonly #limits: CliLimitLedger | null;
  readonly #now: () => number;
  #executable: Promise<CliResolution> | undefined;
  readonly #conversations = new Map<string, CliConversation>();
  /** Secret to this transport: the calls of one stage frame their transcripts alike, and no repository text can. */
  readonly #markerSeed = randomBytes(16).toString("hex");

  constructor(configuration: TransportConfiguration, private readonly dialect: CliDialect, options: CliTransportOptions = {}) {
    this.#support = dialect.support;
    this.id = dialect.support.transport;
    if (configuration.endpoint !== this.#support.endpoint) throw new Error("INVALID_TRANSPORT_ENDPOINT");
    this.#auth = configuration.cli?.auth ?? "subscription_login";
    if (!this.#support.authModes.includes(this.#auth)) throw new Error(`CLI_AUTH_MODE_UNSUPPORTED:${this.#support.transport}:${this.#auth}`);
    this.#oauthTokenEnv = configuration.cli?.oauthTokenEnv ?? null;
    if (this.#auth === "oauth_token" && this.#oauthTokenEnv === null) throw new Error("INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE");
    this.#lookup = options.lookup ?? ((name) => process.env[name]);
    this.#process = options.process ?? { run: runNativeProcess };
    this.#platform = options.platform ?? process.platform;
    this.#node = options.nodeExecutable ?? hostNodeExecutable();
    this.#temporary = options.temporaryDirectory;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
    const ledgerPath = options.limits === undefined ? defaultLimitLedgerPath(this.#lookup, this.#platform) : null;
    this.#limits = options.limits === undefined ? ledgerPath === null ? null : fileLimitLedger(ledgerPath) : options.limits;
    this.#now = options.now ?? Date.now;
  }

  async send(request: TransportRequest, signal: AbortSignal): Promise<TransportResponse> {
    if (signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled", false);
    const oauthToken = this.#auth === "oauth_token" ? this.#lookup(this.#oauthTokenEnv ?? "") ?? "" : null;
    if (oauthToken === "") throw new TransportError("AUTH", `Credential environment variable ${this.#oauthTokenEnv ?? ""} is not set`, false, null, noUsage("credential_missing"));
    const { executable, version } = await this.#resolve();
    const nativeSchema = this.dialect.nativeSchema(request);
    const prompt = serializeCliPrompt(request, { nativeSchema, systemInArguments: true, markerSeed: this.#markerSeed });
    const run = { request, signal, oauthToken, executable, version, nativeSchema };
    await this.#sweep();
    // A conversation that offers tools runs in the CLI's own session. When the model asked for tools, the next turn
    // continues that session with the tool results alone; the CLI reads the rest from its cache. Measured on Claude
    // Code (October 14, 2026, 14,000 tokens of source): a continued turn read 91% of its prompt from the cache, a
    // turn sent whole 19%, and the whole one wrote the rest to the cache again.
    if (this.dialect.session === undefined || (request.tools?.length ?? 0) === 0) return this.#call(run, prompt, await this.#directories(), undefined);
    const last = lastToolRequest(request.messages);
    const previous = last < 0 ? undefined : this.#take(conversationKey(request, last));
    if (previous !== undefined) {
      try {
        const followUp: CliPrompt = { system: prompt.system, body: serializeCliFollowUp(request, last + 1, previous.boundary), boundary: prompt.boundary, callIds: prompt.callIds };
        return await this.#call(run, followUp, previous.directories, { id: previous.sessionId, resume: true }, previous.boundary, previous.usage);
      } catch (error) {
        // A session that cannot be continued (the CLI fails the resume, or answers it unreadably) is sent whole once
        // more. Anything retryable, a throttle above all, goes to the caller's retry, which waits out its backoff or
        // retry hint before sending the conversation whole: resent here at once, it would skip that wait. A usage limit,
        // an auth failure, a refused model or failed start, a cancellation, a timeout or an output ceiling would fail
        // the same way whole and is not repeated. An unreadable continued answer is the session's fault even when the CLI
        // marks it retryable, so it is sent whole here rather than spending one of the caller's attempts.
        if (!(error instanceof TransportError) || error.retryable && error.code !== "MALFORMED_RESPONSE" || ["QUOTA", "CANCELLED", "TIMEOUT", "OUTPUT_LIMIT", "AUTH", "RATE_LIMIT", "INVALID_REQUEST"].includes(error.code)) throw error;
      }
    }
    return this.#call(run, prompt, await this.#directories(), { id: randomUUID(), resume: false }, prompt.boundary);
  }

  /**
   * Removes every conversation still kept for a turn that will not come: the run that owns the transport has settled.
   * Each run is its own process with its own transports, so the two-hour sweep of a later call would never reach them.
   * The transport stays usable.
   */
  async close(): Promise<void> {
    const conversations = [...this.#conversations.values()];
    this.#conversations.clear();
    await Promise.all(conversations.map((conversation) => this.#remove(conversation.directories, conversation.sessionId)));
  }

  /**
   * One CLI process. A session whose model asked for tools is kept for the next turn; everything else is removed. A
   * continued session whose CLI reports usage for the whole conversation (`reported`: what it reported up to the turn
   * before) is charged the difference, the turn alone.
   */
  async #call(run: { readonly request: TransportRequest; readonly signal: AbortSignal; readonly oauthToken: string | null; readonly executable: CliExecutable; readonly version: string; readonly nativeSchema: boolean },
    prompt: CliPrompt, directories: CliDirectories, session: CliInvocationContext["session"], sessionBoundary?: string, reported?: CliUsage): Promise<TransportResponse> {
    const { request, signal, oauthToken, executable, version, nativeSchema } = run;
    let kept = false; let sessionId: () => string | null = () => session?.resume === true ? session.id : null;
    try {
      const context: CliInvocationContext = { request, prompt, work: directories.work, control: directories.control, isolatedHome: directories.isolatedHome, auth: this.#auth, oauthToken, nativeSchema, lookup: this.#lookup, timeoutMs: this.#timeoutMs, platform: this.#platform,
        hostHome: this.#hostHome(), base: this.#baseEnvironment(executable, directories.scratch), ...(session === undefined ? {} : { session }) };
      const invocation = await this.dialect.prepare(context);
      const reader = this.dialect.reader(context);
      const fallback = sessionId; sessionId = () => reader.sessionId?.() ?? fallback();
      const result = await this.#process.run({ executable: executable.command, arguments: [...executable.prefixArguments, ...invocation.arguments], cwd: directories.work,
        environment: invocation.environment, stdin: invocation.stdin, timeoutMs: this.#timeoutMs, maximumOutputBytes: this.#maximumOutputBytes, signal, onLine: (line) => reader.line(line) });
      this.#assertStopped(result, signal);
      const outcome = reader.finish(result.exitCode, result.stderr);
      if (outcome.sessionId !== null) sessionId = () => outcome.sessionId;
      if (!result.treeTerminated) throw new TransportError("HTTP", `CLI_PROCESS_TREE_NOT_TERMINATED: ${this.#support.displayName} left processes running`, false);
      // A provider's notice in place of an answer is a refusal, not a reply to parse.
      const refusal = this.dialect.refusal?.(outcome.text) ?? null;
      const text = sessionBoundary === undefined || sessionBoundary === prompt.boundary ? outcome.text : unframedAssistant(outcome.text, sessionBoundary);
      const reply = refusal === null ? interpretCliReply(text, request, prompt.boundary, outcome.structured, prompt.callIds) : { text: null, structured: null, toolCalls: Object.freeze([]) };
      await this.#limits?.clear(this.id).catch(() => undefined);
      const usage: CliUsage = Object.freeze({ inputTokens: outcome.usage.inputTokens ?? null, outputTokens: outcome.usage.outputTokens ?? null, cacheReadTokens: outcome.usage.cacheReadTokens ?? null, cacheWriteTokens: outcome.usage.cacheWriteTokens ?? null });
      if (session !== undefined && sessionBoundary !== undefined && reply.toolCalls.length > 0) {
        this.#conversations.set(conversationKey(request, request.messages.length), { sessionId: outcome.sessionId ?? session.id, boundary: sessionBoundary, directories, at: this.#now(), usage });
        kept = true;
      }
      return Object.freeze({
        text: reply.text, structured: reply.structured, toolCalls: reply.toolCalls, refusal,
        usage: session?.resume === true && reported !== undefined && this.dialect.session?.cumulativeUsage === true ? turnUsage(usage, reported) : usage,
        continuation: null, structuredOutputTier: request.responseSchema === undefined ? "prompt_json" : nativeSchema ? "native_structured" : "prompt_json",
        providerRequestId: outcome.sessionId, transportVersion: `${this.#support.vendor}/${version}`,
      });
    } catch (error) {
      if (error instanceof TransportError && error.code === "QUOTA") {
        const now = this.#now();
        await this.#limits?.record({ transport: this.id, observedAt: now, resetsAt: error.retryAfterMs === null ? resetTime(error.message, now) : now + error.retryAfterMs, message: error.message }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (!kept) await this.#remove(directories, session !== undefined || this.dialect.session?.storesEveryCall === true ? sessionId() : undefined);
    }
  }

  /** A fresh temporary root: an empty working directory, a control directory for arbitra's own files, an isolated home. */
  async #directories(): Promise<CliDirectories> {
    const root = await realpath(await mkdtemp(join(this.#temporary ?? tmpdir(), "arbitra-cli-")));
    const directories = { root, work: join(root, "work"), control: join(root, "control"), isolatedHome: join(root, "home"), scratch: join(root, "tmp") };
    await Promise.all([directories.work, directories.control, directories.isolatedHome, directories.scratch].map((directory) => mkdir(directory, { mode: 0o700 })));
    return directories;
  }

  /** Removes a call's directories and, when `session` is given (null: its ID was never seen), what the CLI stored for it. */
  async #remove(directories: CliDirectories, session: string | null | undefined): Promise<void> {
    if (session !== undefined) await this.dialect.session?.forget(directories.work, session, { auth: this.#auth, isolatedHome: directories.isolatedHome, lookup: this.#lookup, hostHome: this.#hostHome() }).catch(() => undefined);
    await rm(directories.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  #take(key: string): CliConversation | undefined {
    const conversation = this.#conversations.get(key);
    if (conversation !== undefined) this.#conversations.delete(key);
    return conversation;
  }

  /** A conversation that was never continued (its run stopped) is removed after two hours. */
  async #sweep(): Promise<void> {
    const now = this.#now();
    for (const [key, conversation] of [...this.#conversations]) {
      if (now - conversation.at < CONVERSATION_TTL_MS) continue;
      this.#conversations.delete(key);
      await this.#remove(conversation.directories, conversation.sessionId);
    }
  }

  #assertStopped(result: NativeProcessResult, signal: AbortSignal): void {
    if (result.stopped === null) return;
    if (result.stopped === "violation") {
      if (result.violation instanceof TransportError) throw result.violation;
      throw new TransportError("MALFORMED_RESPONSE", `CLI_EVENT_STREAM_INVALID: ${result.violation instanceof Error ? result.violation.message.slice(0, 200) : "unreadable event"}`, false);
    }
    if (result.stopped === "cancelled" || signal.aborted) throw new TransportError("CANCELLED", "Provider request cancelled", false);
    if (result.stopped === "timeout") throw new TransportError("TIMEOUT", `${this.#support.displayName} did not finish within ${this.#timeoutMs}ms`, true);
    if (result.stopped === "output_limit") throw new TransportError("OUTPUT_LIMIT", `MODEL_OUTPUT_LIMIT_REACHED: ${this.#support.displayName} wrote more than ${this.#maximumOutputBytes} bytes`, false);
    throw new TransportError("INVALID_REQUEST", `CLI_SPAWN_FAILED: ${this.#support.displayName} could not be started`, false, null, noUsage("cli_not_started"));
  }

  async #resolve(): Promise<CliResolution> {
    // A CLI updated in place (npm's Codex, winget's agy) runs new code under the path it had: each call compares the
    // file's size and modification time with the probe's, and a changed file is resolved and its version probed again.
    const cached = this.#executable;
    if (cached !== undefined) {
      const resolved = await cached;
      if (resolved.stamp === null || await executableStamp(resolved.executable.path) === resolved.stamp) return resolved;
      if (this.#executable === cached) this.#executable = undefined;
    }
    this.#executable ??= (async () => {
      const { resolution, version: known } = await supportedCliExecutable(this.#support, { platform: this.#platform, lookup: this.#lookup, nodeExecutable: this.#node }, this.#probeOptions());
      if (!resolution.found) throw new TransportError("INVALID_REQUEST", `CLI_NOT_INSTALLED: ${resolution.detail}. ${this.#support.installInstruction}`, false, null, noUsage("cli_unavailable"));
      // Taken before the probe, so a change while it runs is seen on the next call.
      const stamp = await executableStamp(resolution.executable.path);
      const version = known ?? await probeCliVersion(resolution.executable, this.#support, this.#probeOptions());
      if (version === null) throw new TransportError("INVALID_REQUEST", `CLI_VERSION_UNREADABLE: ${this.#support.displayName} at ${resolution.executable.path} did not report a version`, false, null, noUsage("cli_unavailable"));
      if (!versionInRange(version, this.#support.versionRange)) {
        throw new TransportError("INVALID_REQUEST", `CLI_VERSION_UNSUPPORTED: ${this.#support.displayName} ${version} is outside the supported range ${this.#support.versionRange.minimum} to below ${this.#support.versionRange.below}`, false, null, noUsage("cli_unavailable"));
      }
      return Object.freeze({ executable: resolution.executable, version, stamp });
    })();
    // A failed resolution is retried on the next call (the operator may have installed or upgraded the CLI).
    this.#executable.catch(() => { this.#executable = undefined; });
    return this.#executable;
  }

  #probeOptions(): CliCommandOptions { return { lookup: this.#lookup, process: this.#process, platform: this.#platform, nodeExecutable: this.#node, temporaryDirectory: this.#temporary }; }
  #hostHome(): string | undefined { return this.#lookup(this.#platform === "win32" ? "USERPROFILE" : "HOME") ?? this.#lookup("HOME"); }
  #baseEnvironment(executable: CliExecutable, scratch: string): Record<string, string> {
    return cliBaseEnvironment(executable, scratch, { lookup: this.#lookup, platform: this.#platform, nodeExecutable: this.#node, home: this.#hostHome() });
  }
}

export function cliBaseEnvironment(executable: CliExecutable, scratch: string, host: { readonly lookup: HostLookup; readonly platform: NodeJS.Platform; readonly nodeExecutable: string; readonly home: string | undefined }): Record<string, string> {
  const environment: Record<string, string> = { PATH: childPath(executable, null, host.platform, host.nodeExecutable, host.lookup), TMPDIR: scratch, TMP: scratch, TEMP: scratch, NO_COLOR: "1", TERM: "dumb", CI: "1" };
  if (host.home !== undefined) environment["HOME"] = host.home;
  for (const name of [...PASSTHROUGH, ...(host.platform === "win32" ? WINDOWS_PASSTHROUGH : [])]) { const value = host.lookup(name); if (value !== undefined && value !== "") environment[name] = value; }
  return environment;
}

export interface CliCommandOptions {
  readonly lookup: HostLookup;
  readonly process?: NativeProcessPort | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly nodeExecutable?: string | undefined;
  readonly temporaryDirectory?: string | undefined;
  readonly extraEnvironment?: Readonly<Record<string, string>>;
}

/** Runs a short, model-free CLI command (version, auth status) in an empty directory with the sanitized environment. */
export async function runCliCommand(executable: CliExecutable, commandArguments: readonly string[], options: CliCommandOptions): Promise<NativeProcessResult> {
  const root = await realpath(await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "arbitra-cli-probe-")));
  try {
    const platform = options.platform ?? process.platform;
    const environment = { ...cliBaseEnvironment(executable, root, { lookup: options.lookup, platform, nodeExecutable: options.nodeExecutable ?? hostNodeExecutable(),
      home: options.lookup(platform === "win32" ? "USERPROFILE" : "HOME") ?? options.lookup("HOME") }), ...options.extraEnvironment };
    return await (options.process ?? { run: runNativeProcess }).run({ executable: executable.command, arguments: [...executable.prefixArguments, ...commandArguments], cwd: root,
      environment, stdin: "", timeoutMs: PROBE_TIMEOUT_MS, maximumOutputBytes: 256 * 1024, signal: new AbortController().signal });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined); }
}

/** An executable file's size and modification time, which an update in place changes; null when it cannot be read. */
async function executableStamp(path: string): Promise<string | null> {
  return stat(path).then((file) => `${file.size}:${file.mtimeMs}`, () => null);
}

/** The CLI's own version (`2.1.282 (Claude Code)`, `codex-cli 0.154.0-alpha.6`, `0.61.0`) as major.minor.patch. */
export async function probeCliVersion(executable: CliExecutable, support: CliTransportSupport, options: CliCommandOptions): Promise<string | null> {
  const result = await runCliCommand(executable, ["--version"], options);
  if (result.stopped !== null || result.exitCode !== 0) return null;
  return /(\d{1,6}\.\d{1,6}\.\d{1,6})/u.exec(result.stdout)?.[1] ?? null;
}

/**
 * The installation a call uses: of several, the first whose version is supported, with that version; of one, or of
 * several none of which is supported, the first, whose version the caller probes and reports.
 */
export async function supportedCliExecutable(support: CliTransportSupport, host: DiscoveryHost, options: CliCommandOptions): Promise<{ readonly resolution: CliExecutableResolution; readonly version: string | null }> {
  const candidates = await cliExecutableCandidates(support, host);
  const installed = candidates.filter((candidate) => candidate.found);
  const first = candidates[0] ?? { found: false as const, reason: "not_found" as const, detail: `${support.command} was not found through ${support.executableEnvVar}, PATH or the documented install locations` };
  if (installed.length <= 1) return { resolution: first, version: null };
  for (const candidate of installed) {
    if (!candidate.found) continue;
    const version = await probeCliVersion(candidate.executable, support, options).catch(() => null);
    if (version !== null && versionInRange(version, support.versionRange)) return { resolution: candidate, version };
  }
  return { resolution: first, version: null };
}

export function cliTransportFactory(dialectId: string) {
  return (configuration: TransportConfiguration, options: { readonly credential?: (name: string) => string | undefined; readonly cli?: CliTransportOptions }): ProviderTransport => {
    const dialect = CLI_DIALECTS[dialectId];
    if (dialect === undefined) throw new Error(`UNKNOWN_TRANSPORT:${dialectId}`);
    return new CliTransport(configuration, dialect, { ...options.cli, ...(options.credential === undefined || options.cli?.lookup !== undefined ? {} : { lookup: options.credential }) });
  };
}


/** The conversation a request's first `length` messages make, for the CLI and model it goes to. */
function conversationKey(request: TransportRequest, length: number): string {
  return createHash("sha256").update(JSON.stringify({ model: request.modelId, tools: request.tools ?? [], schema: request.responseSchema ?? null, messages: request.messages.slice(0, length) })).digest("hex");
}

/** A continued turn's own usage, where the CLI reports the whole conversation's: what it reports less what it had. */
function turnUsage(usage: CliUsage, before: CliUsage): CliUsage {
  const less = (now: number | null, then: number | null): number | null => now === null ? null : Math.max(0, now - (then ?? 0));
  return Object.freeze({ inputTokens: less(usage.inputTokens, before.inputTokens), outputTokens: less(usage.outputTokens, before.outputTokens),
    cacheReadTokens: less(usage.cacheReadTokens, before.cacheReadTokens), cacheWriteTokens: less(usage.cacheWriteTokens, before.cacheWriteTokens) });
}

/** The index of the last assistant message that asked for tools, or -1. */
function lastToolRequest(messages: TransportRequest["messages"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "assistant" && (messages[index]?.toolCalls?.length ?? 0) > 0) return index;
  return -1;
}

/** A continued session's reply may come inside the markers of the session's first boundary; they are removed. */
function unframedAssistant(reply: string, boundary: string): string {
  const begin = `<<<BEGIN assistant ${boundary}>>>`; const end = `<<<END assistant ${boundary}>>>`;
  const trimmed = reply.trim();
  if (!trimmed.startsWith(begin)) return reply;
  const inner = trimmed.slice(begin.length).trim();
  return inner.endsWith(end) ? inner.slice(0, -end.length).trim() : inner;
}
