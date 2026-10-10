import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { noUsage, TransportError, withUsageEvidence, type TransportRequest, type TransportUsage } from "../../transport-contract.js";
import type { CliPrompt } from "./prompt.js";
import { classifyCliFailure, cliFailureDetail } from "./classify.js";
import { requireCliTransportSupport, type CliAuthMode, type CliTransportSupport } from "./support.js";

/**
 * Per-vendor invocation: the flags that make each CLI a plain completion engine, the
 * environment it needs to find its own login, and the reader for its event stream. A reader
 * throws from `line` to stop the process at the first forbidden event.
 */
export interface CliInvocationContext {
  readonly request: TransportRequest;
  readonly prompt: CliPrompt;
  /** Empty working directory the CLI runs in. */
  readonly work: string;
  /** arbitra-owned files (system prompt, schema), outside the working directory. */
  readonly control: string;
  /** Isolated home and configuration directory, used only for token authentication. */
  readonly isolatedHome: string;
  readonly auth: CliAuthMode;
  readonly base: Readonly<Record<string, string>>;
  readonly hostHome: string | undefined;
  readonly lookup: (name: string) => string | undefined;
  readonly oauthToken: string | null;
  readonly nativeSchema: boolean;
  readonly timeoutMs: number;
  readonly platform: NodeJS.Platform;
}
export interface CliInvocation { readonly arguments: readonly string[]; readonly environment: Readonly<Record<string, string>>; readonly stdin: string }
export interface CliOutcome { readonly text: string; readonly usage: Partial<TransportUsage>; readonly sessionId: string | null; readonly structured?: unknown }
export interface CliStreamReader {
  line(line: string): void;
  /** The completed reply, or a classified failure. Called only when the process was not stopped. */
  finish(exitCode: number | null, stderr: string): CliOutcome;
}
export interface CliDialect {
  readonly support: CliTransportSupport;
  /** Whether a response schema is enforced by the CLI itself rather than by the prompt. */
  nativeSchema(request: TransportRequest): boolean;
  prepare(context: CliInvocationContext): Promise<CliInvocation>;
  reader(context: CliInvocationContext): CliStreamReader;
}

export function forbiddenToolUse(support: CliTransportSupport, what: string): TransportError {
  return new TransportError("MALFORMED_RESPONSE", `CLI_AGENT_TOOL_USE_FORBIDDEN: ${support.displayName} attempted ${what.slice(0, 120)}; the CLI's own agent tools are disabled and nothing it did is trusted`, false);
}

/** A clean exit without the CLI's completion event is unreadable output, not a service failure. */
function incomplete(support: CliTransportSupport, exitCode: number | null, failureText: string): TransportError {
  if (exitCode === 0 && failureText.trim() === "") return new TransportError("MALFORMED_RESPONSE", `CLI_EVENT_STREAM_INVALID: ${support.displayName} exited without a completion event`, false);
  return classifyCliFailure(support, failureText, exitCode);
}

function record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function count(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function parseLine(line: string): Record<string, unknown> | null { try { return record(JSON.parse(line)); } catch { return null; } }
function effortParameter(request: TransportRequest, support: CliTransportSupport, allowed: Readonly<Record<string, (value: unknown) => boolean>>): Readonly<Record<string, string | number>> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(request.effortParams ?? {})) {
    const valid = allowed[key];
    if (valid === undefined || !valid(value)) throw new TransportError("INVALID_REQUEST", `CLI_EFFORT_PARAMETER_UNSUPPORTED: ${support.displayName} accepts effort parameters ${Object.keys(allowed).join(", ") || "none"}; ${key} is not usable`, false);
    result[key] = value as string | number;
  }
  return result;
}

const CLAUDE = requireCliTransportSupport("claude-code-cli");
const CODEX = requireCliTransportSupport("codex-cli");
const GEMINI = requireCliTransportSupport("gemini-cli");
const ANTIGRAVITY = requireCliTransportSupport("antigravity-cli");

/**
 * Claude Code in print mode. `--tools ""` removes every built-in tool, `--safe-mode` disables
 * CLAUDE.md, skills, plugins, hooks and MCP, `--setting-sources ""` ignores settings files,
 * and the system prompt is replaced outright. Thinking is off unless requested, and an
 * output-ceiling stop is fatal: Claude Code would otherwise ask the model to continue.
 */
export const claudeCodeDialect: CliDialect = {
  support: CLAUDE,
  nativeSchema: (request) => request.responseSchema !== undefined && (request.tools?.length ?? 0) === 0,
  async prepare(context) {
    const effort = effortParameter(context.request, CLAUDE, { effort: (value) => typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value), thinkingTokens: (value) => count(value) !== null });
    await writeFile(join(context.control, "system.md"), context.prompt.system, { mode: 0o600 });
    const token = context.auth === "oauth_token";
    if (token) await mkdir(join(context.isolatedHome, ".claude"), { recursive: true, mode: 0o700 });
    const environment: Record<string, string> = {
      ...context.base,
      ...(token ? { HOME: context.isolatedHome, CLAUDE_CONFIG_DIR: join(context.isolatedHome, ".claude"), CLAUDE_CODE_OAUTH_TOKEN: context.oauthToken ?? "" }
        : { ...(context.lookup("CLAUDE_CONFIG_DIR") === undefined ? {} : { CLAUDE_CONFIG_DIR: context.lookup("CLAUDE_CONFIG_DIR") ?? "" }) }),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(context.request.maximumOutputTokens),
      MAX_THINKING_TOKENS: String(effort["thinkingTokens"] ?? 0),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    };
    const schema = context.nativeSchema && context.request.responseSchema !== undefined ? ["--json-schema", JSON.stringify(context.request.responseSchema)] : [];
    return {
      arguments: ["-p", "--output-format", "stream-json", "--verbose", "--model", context.request.modelId, "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
        "--setting-sources", "", "--safe-mode", "--no-session-persistence", "--disable-slash-commands", "--system-prompt-file", join(context.control, "system.md"),
        ...(typeof effort["effort"] === "string" ? ["--effort", effort["effort"]] : []), ...schema],
      environment, stdin: context.prompt.body,
    };
  },
  reader(context) {
    const allowedTools = context.nativeSchema ? ["StructuredOutput"] : [];
    let result: Record<string, unknown> | null = null; let rejected: string | null = null; let sessionId: string | null = null;
    let lastText: string | null = null;
    return {
      line(line) {
        const event = parseLine(line);
        if (event === null) return;
        sessionId = text(event["session_id"]) ?? sessionId;
        if (event["type"] === "system" && event["subtype"] === "init") {
          const tools = Array.isArray(event["tools"]) ? event["tools"].map(String) : [];
          const unexpected = tools.filter((tool) => !allowedTools.includes(tool));
          if (unexpected.length > 0) throw forbiddenToolUse(CLAUDE, `to start with tools ${unexpected.join(", ")}`);
          if (Array.isArray(event["mcp_servers"]) && event["mcp_servers"].length > 0) throw forbiddenToolUse(CLAUDE, "to start with MCP servers");
          const keySource = text(event["apiKeySource"]);
          if (context.auth === "subscription_login" && keySource !== null && keySource !== "none") {
            throw new TransportError("AUTH", `CLI_API_KEY_IN_USE: Claude Code reported API-key authentication (${keySource.slice(0, 40)}) in subscription mode; nothing was sent on a key`, false);
          }
        }
        if (event["type"] === "assistant") {
          const message = record(event["message"]);
          if (event["error"] === "max_output_tokens" || event["api_error"] === "max_output_tokens") throw new TransportError("OUTPUT_LIMIT", "MODEL_OUTPUT_LIMIT_REACHED: Claude Code stopped at maximumOutputTokens", false);
          for (const part of Array.isArray(message?.["content"]) ? message["content"] as unknown[] : []) {
            const content = record(part);
            if (content?.["type"] === "tool_use" && !allowedTools.includes(String(content["name"]))) throw forbiddenToolUse(CLAUDE, `tool ${String(content["name"])}`);
            if (content?.["type"] === "text") lastText = text(content["text"]);
          }
        }
        // Claude Code answers an output-ceiling stop by asking the model to continue; that
        // would spend more of the plan on an answer arbitra has already rejected.
        if (event["type"] === "user" && event["isSynthetic"] === true && /output token limit/iu.test(JSON.stringify(event["message"] ?? ""))) {
          throw new TransportError("OUTPUT_LIMIT", "MODEL_OUTPUT_LIMIT_REACHED: Claude Code stopped at maximumOutputTokens", false);
        }
        if (event["type"] === "rate_limit_event") {
          const info = record(event["rate_limit_info"]);
          if (info?.["status"] === "rejected") rejected = `usage limit reached (${String(info["rateLimitType"] ?? "plan")})|${String(count(info["resetsAt"]) ?? "")}`;
        }
        if (event["type"] === "result") result = event;
      },
      finish(exitCode, stderr) {
        if (result === null) throw incomplete(CLAUDE, exitCode, `${rejected ?? ""}\n${stderr}`);
        const reply = text(result["result"]) ?? lastText ?? "";
        if (result["is_error"] === true || exitCode !== 0) {
          const failure = classifyCliFailure(CLAUDE, `${rejected ?? ""}\n${reply}\n${String(result["api_error_status"] ?? "")}\n${stderr}`, exitCode);
          // A usage-limit refusal before any assistant output, with no usage reported, consumed nothing.
          const refusedUnprocessed = failure.code === "QUOTA" && rejected !== null && lastText === null && [record(result["usage"])?.["input_tokens"], record(result["usage"])?.["output_tokens"]].every((value) => value === undefined || value === 0);
          throw refusedUnprocessed ? withUsageEvidence(failure, noUsage("cli_usage_limit_refused")) : failure;
        }
        const usage = record(result["usage"]);
        const input = count(usage?.["input_tokens"]); const read = count(usage?.["cache_read_input_tokens"]); const write = count(usage?.["cache_creation_input_tokens"]);
        const complete = usage !== null && (usage["cache_read_input_tokens"] === undefined || read !== null) && (usage["cache_creation_input_tokens"] === undefined || write !== null);
        return { text: reply, sessionId, ...(result["structured_output"] === undefined ? {} : { structured: result["structured_output"] }),
          usage: { inputTokens: input === null || !complete ? null : input + (read ?? 0) + (write ?? 0), outputTokens: count(usage?.["output_tokens"]), cacheReadTokens: read, cacheWriteTokens: write } };
      },
    };
  },
};

/** Codex agent features that expose tools or load outside instructions. None may run. */
export const CODEX_DISABLED_FEATURES: readonly string[] = Object.freeze(["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation",
  "multi_agent", "view_image", "hooks", "skill_search", "tool_suggest", "goals", "sleep_tool", "in_app_browser", "shell_snapshot", "workspace_dependencies", "remote_plugin", "skill_mcp_dependency_install"]);
const CODEX_ALLOWED_ITEMS = new Set(["agent_message", "reasoning", "error"]);

/**
 * `codex exec` with an ephemeral session, no user config or rules, the read-only sandbox,
 * approvals never granted and every optional tool feature disabled. Codex still declares a
 * few built-in functions that cannot be switched off, so any command, file, MCP, search or
 * collaboration item in the event stream stops the process and fails the call.
 */
export const codexDialect: CliDialect = {
  support: CODEX,
  nativeSchema: (request) => request.responseSchema !== undefined && (request.tools?.length ?? 0) === 0,
  async prepare(context) {
    const effort = effortParameter(context.request, CODEX, { effort: (value) => typeof value === "string" && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value) });
    const schemaPath = join(context.control, "schema.json");
    if (context.nativeSchema) await writeFile(schemaPath, JSON.stringify(context.request.responseSchema), { mode: 0o600 });
    const codexHome = context.lookup("CODEX_HOME");
    const toml = (value: string) => JSON.stringify(value);
    return {
      arguments: ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never",
        "--cd", context.work, "--model", context.request.modelId, ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
        "-c", "web_search=\"disabled\"", "-c", "project_doc_max_bytes=0", "-c", "include_environment_context=false", "-c", "include_apps_instructions=false",
        "-c", "include_permissions_instructions=false", "-c", "include_collaboration_mode_instructions=false", "-c", "approval_policy=\"never\"", "-c", "mcp_servers={}",
        "-c", `base_instructions=${toml(context.prompt.system)}`,
        ...(typeof effort["effort"] === "string" ? ["-c", `model_reasoning_effort=${toml(effort["effort"])}`] : []),
        ...(context.nativeSchema ? ["--output-schema", schemaPath] : []), "-"],
      environment: { ...context.base, ...(codexHome === undefined ? {} : { CODEX_HOME: codexHome }) },
      stdin: context.prompt.body,
    };
  },
  reader() {
    let threadId: string | null = null; let reply: string | null = null; let usage: Record<string, unknown> | null = null;
    let completed = false; const failures: string[] = [];
    return {
      line(line) {
        const event = parseLine(line);
        if (event === null) return;
        if (event["type"] === "thread.started") threadId = text(event["thread_id"]);
        if (typeof event["type"] === "string" && event["type"].startsWith("item.")) {
          const item = record(event["item"]);
          const kind = String(item?.["type"] ?? "unknown");
          if (!CODEX_ALLOWED_ITEMS.has(kind)) throw forbiddenToolUse(CODEX, `a ${kind} item`);
          if (kind === "agent_message" && event["type"] === "item.completed") reply = text(item?.["text"]);
        }
        if (event["type"] === "turn.completed") { completed = true; usage = record(event["usage"]); }
        if (event["type"] === "turn.failed") failures.push(text(record(event["error"])?.["message"]) ?? "turn failed");
        if (event["type"] === "error") failures.push(text(event["message"]) ?? "error");
      },
      finish(exitCode, stderr) {
        if (!completed || reply === null || exitCode !== 0) throw incomplete(CODEX, exitCode, `${failures.join("\n")}\n${stderr}`);
        const read = count(usage?.["cached_input_tokens"]);
        return { text: reply, sessionId: threadId,
          usage: { inputTokens: count(usage?.["input_tokens"]), outputTokens: count(usage?.["output_tokens"]), cacheReadTokens: read, cacheWriteTokens: count(usage?.["cache_write_input_tokens"]) } };
      },
    };
  },
};

/** Appended to the stdin prompt by Gemini's headless flag. */
export const GEMINI_PROMPT_SUFFIX = "(End of input. Write your reply now.)";

/**
 * Gemini CLI headless with stream-json events. Workspace settings in the empty working
 * directory register no tools, allow no MCP server, disable hooks, skills, agents and memory,
 * and point context loading at a file that never exists; the system prompt is replaced
 * through GEMINI_SYSTEM_MD and extensions are disabled on the command line.
 */
export const geminiDialect: CliDialect = {
  support: GEMINI,
  nativeSchema: () => false,
  async prepare(context) {
    effortParameter(context.request, GEMINI, {});
    await writeFile(join(context.control, "system.md"), context.prompt.system, { mode: 0o600 });
    await mkdir(join(context.work, ".gemini"), { recursive: true });
    await writeFile(join(context.work, ".gemini", "settings.json"), JSON.stringify(GEMINI_WORKSPACE_SETTINGS), { mode: 0o600 });
    const project = context.lookup("GOOGLE_CLOUD_PROJECT");
    return {
      arguments: ["--output-format", "stream-json", "--approval-mode", "plan", "--extensions", "none", "--model", context.request.modelId, "--prompt", GEMINI_PROMPT_SUFFIX],
      environment: { ...context.base, GEMINI_SYSTEM_MD: join(context.control, "system.md"), GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_CLI_NO_RELAUNCH: "true", NO_BROWSER: "true",
        ...(project === undefined ? {} : { GOOGLE_CLOUD_PROJECT: project }) },
      stdin: context.prompt.body,
    };
  },
  reader() {
    let sessionId: string | null = null; let reply = ""; let result: Record<string, unknown> | null = null; const failures: string[] = [];
    return {
      line(line) {
        const event = parseLine(line);
        if (event === null) return;
        if (event["type"] === "init") sessionId = text(event["session_id"]);
        if (event["type"] === "tool_use" || event["type"] === "tool_result") throw forbiddenToolUse(GEMINI, `tool ${String(event["tool_name"] ?? event["tool_id"] ?? "unknown")}`);
        if (event["type"] === "message" && event["role"] === "assistant") reply += text(event["content"]) ?? "";
        if (event["type"] === "error") failures.push(text(event["message"]) ?? "error");
        if (event["type"] === "result") result = event;
      },
      finish(exitCode, stderr) {
        if (result === null || result["status"] !== "success" || exitCode !== 0) {
          throw incomplete(GEMINI, exitCode, `${failures.join("\n")}\n${text(record(result?.["error"])?.["message"]) ?? ""}\n${stderr}`);
        }
        const stats = record(result["stats"]);
        return { text: reply, sessionId, usage: { inputTokens: count(stats?.["input_tokens"]), outputTokens: count(stats?.["output_tokens"]), cacheReadTokens: count(stats?.["cached"]), cacheWriteTokens: null } };
      },
    };
  },
};

export const GEMINI_WORKSPACE_SETTINGS = Object.freeze({
  tools: { core: ["arbitra-no-tools"] }, mcp: { allowed: ["arbitra-no-mcp"] }, mcpServers: {},
  context: { fileName: "ARBITRA_NO_CONTEXT_FILE.md", includeDirectoryTree: false },
  hooksConfig: { enabled: false }, skills: { enabled: false }, experimental: { enableAgents: false, autoMemory: false },
});

/**
 * Largest prompt, in UTF-8 bytes, the Antigravity CLI takes whole. It keeps only the first
 * 191,580 bytes of a prompt and silently replaces the rest with "<truncated N bytes>",
 * whether the prompt is the `-p` argument (measured live on agy 1.2.14, macOS) or a
 * stream-json message on stdin (agy 1.3.3, Windows).
 */
export const ANTIGRAVITY_PROMPT_LIMIT = 190_000;

/**
 * How the prompt reaches the Antigravity CLI. A command line cannot carry the limit above on
 * Windows (32,767 characters in all) or Linux (128 KiB per argument), so there the prompt is
 * one stream-json message on stdin (`--input-format stream-json`, agy 1.1.15 and later).
 * macOS keeps the `-p` argument, the path its live evidence was recorded on.
 */
export function antigravityPromptChannel(platform: NodeJS.Platform): "argument" | "stdin" { return platform === "darwin" ? "argument" : "stdin"; }

/** stderr notices of a tool call soft-denied in headless mode (the run otherwise continues and exits 0). */
const ANTIGRAVITY_DENIAL = /\b(?:tool|command|action|permission)\b[^\n]{0,120}\b(?:denied|requires? (?:approval|permission)|not (?:approved|permitted|allowed))|\bsoft[- ]denied\b|approval required/iu;
/** Step types of a plain answer (observed live on agy 1.2.11); any other step is agent tool use. */
const ANTIGRAVITY_STEPS = new Set(["user_input", "agent_response", "finish", "thinking", "reasoning", "planner_response"]);

/**
 * The text the CLI stored for one step of a conversation, as lines, or none when it cannot
 * be read. The stream names an `error_message` step without saying what failed (observed live
 * on agy 1.3.3: {"step_index":2,"state":"DONE","step_type":"error_message","duration_seconds":0}).
 * The reason is only in the CLI's own conversation database, as the readable runs of a protobuf
 * payload. The row can trail the event, so the read is tried for up to half a second.
 */
function antigravityStepText(home: string | undefined, step: Record<string, unknown> | null): readonly string[] {
  const conversation = text(step?.["conversation_id"]); const index = count(step?.["step_index"]);
  if (home === undefined || conversation === null || !/^[A-Za-z0-9-]{1,80}$/u.test(conversation) || index === null) return [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    try {
      const database = new DatabaseSync(join(home, ".gemini", "antigravity-cli", "conversations", `${conversation}.db`), { readOnly: true });
      try {
        const row = database.prepare("SELECT step_payload FROM steps WHERE idx = ?").get(index);
        const payload = row?.["step_payload"];
        // Identifiers of the conversation and its trajectory are readable runs too; they are not the reason.
        const lines = payload instanceof Uint8Array ? (Buffer.from(payload).toString("latin1").match(/[\x20-\x7e]{12,}/gu) ?? []).filter((run) => !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u.test(run)) : [];
        if (lines.length > 0) return lines;
      } finally { database.close(); }
    } catch { /* No database, or not this layout: the reason stays unknown. */ }
  }
  return [];
}

/**
 * The CLI's own step for a model call that failed, which is not tool use. Observed live on agy
 * 1.3.3 (P20 pilot, four of four such steps): Gemini 3.8 Flash passed its 65,536 output tokens,
 * thinking included, and the step read "Your previous response was cut off because it exceeded
 * the output token limit. Please continue from where you left off". The reason is classified
 * like any CLI failure. The CLI would go on to retry by itself; arbitra stops it instead, so a
 * reply continued past the output limit is never accepted.
 */
function antigravityModelFailure(home: string | undefined, step: Record<string, unknown> | null): TransportError {
  const lines = antigravityStepText(home, step);
  // An unread or unrecognised failure is retried within the usual bounds, as the CLI itself would retry it.
  if (lines.length === 0) return new TransportError("HTTP", "CLI_MODEL_CALL_FAILED: the Antigravity CLI reported a failed model call and its reason could not be read", true);
  const failure = classifyCliFailure(ANTIGRAVITY, lines.join("\n"), 1);
  return failure.message.startsWith("CLI_FAILED") ? new TransportError("HTTP", `CLI_MODEL_CALL_FAILED: the Antigravity CLI reported a failed model call: ${cliFailureDetail(lines.join(" "))}`, true) : failure;
}

/**
 * Antigravity CLI (`agy`), Google's CLI for personal Google AI subscriptions, in headless
 * print mode with stream-json events. It has no documented system-prompt flag, so the engine
 * preamble and system text lead the prompt; `--sandbox` confines it, permissions are never
 * skipped, and tool steps in the stream or soft-denied tool notices on stderr fail the call.
 * The prompt travels as the `-p` argument or on stdin (`antigravityPromptChannel`); on stdin
 * a response schema goes in a file, so no model-sized text is on the command line.
 */
export const antigravityDialect: CliDialect = {
  support: ANTIGRAVITY,
  nativeSchema: (request) => request.responseSchema !== undefined && (request.tools?.length ?? 0) === 0,
  async prepare(context) {
    const effort = effortParameter(context.request, ANTIGRAVITY, { effort: (value) => typeof value === "string" && ["low", "medium", "high", "max"].includes(value) });
    const prompt = `${context.prompt.system}\n\n${context.prompt.body}`;
    const bytes = Buffer.byteLength(prompt, "utf8");
    if (bytes > ANTIGRAVITY_PROMPT_LIMIT) throw new TransportError("INVALID_REQUEST", `CLI_PROMPT_TOO_LARGE: the Antigravity CLI keeps at most ${ANTIGRAVITY_PROMPT_LIMIT} bytes of a prompt (it silently drops the rest of a longer one); this request has ${bytes}. Lower limits.contextTokens for profiles on this endpoint (see docs/setup.md) or use another transport for this role`, false);
    const passthrough = Object.fromEntries(["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].flatMap((name) => { const value = context.lookup(name); return value === undefined || value === "" ? [] : [[name, value]]; }));
    const onStdin = antigravityPromptChannel(context.platform) === "stdin";
    const schemaPath = join(context.control, "schema.json");
    if (onStdin && context.nativeSchema) await writeFile(schemaPath, JSON.stringify(context.request.responseSchema), { mode: 0o600 });
    return {
      // Effort is usually part of the model slug (gemini-3.8-flash-low); a bare slug such as
      // gemini-3.8-flash needs effort.params {"effort": ...} or the CLI refuses the selection.
      arguments: [...(onStdin ? ["--input-format", "stream-json"] : ["-p", prompt]), "--output-format", "stream-json", "--model", context.request.modelId, ...(typeof effort["effort"] === "string" ? ["--effort", effort["effort"]] : []),
        "--sandbox", "--disable-slash-commands", "--print-timeout", `${Math.max(1, Math.ceil(context.timeoutMs / 1_000))}s`,
        ...(context.nativeSchema ? ["--json-schema", onStdin ? schemaPath : JSON.stringify(context.request.responseSchema)] : [])],
      // One message per line; the CLI runs its single turn and exits when stdin ends.
      environment: { ...context.base, ...passthrough }, stdin: onStdin ? `${JSON.stringify({ event: "user", message: { content: prompt } })}\n` : "",
    };
  },
  reader(context) {
    let envelope: Record<string, unknown> | null = null; let streamed = "";
    return {
      // Events are {"event": <kind>, <kind>: {...}}: init, step_update (one per agent step) and result.
      line(line) {
        const event = parseLine(line);
        if (event === null) return;
        const kind = String(event["event"] ?? "");
        const payload = record(event[kind]);
        if (kind === "step_update") {
          const step = String(payload?.["step_type"] ?? "unknown");
          if (step === "error_message") throw antigravityModelFailure(context.hostHome, payload);
          if (!ANTIGRAVITY_STEPS.has(step)) throw forbiddenToolUse(ANTIGRAVITY, `a ${step.slice(0, 60)} step${typeof payload?.["tool_name"] === "string" ? ` (${payload["tool_name"].slice(0, 40)})` : ""}`);
          if (step === "agent_response") streamed += text(payload?.["text_delta"]) ?? "";
        } else if (kind === "result" && payload !== null) {
          if (String(payload["status"]).toUpperCase() === "WAITING") throw forbiddenToolUse(ANTIGRAVITY, "an action that waits for approval");
          envelope = payload;
        } else if (kind !== "init" && /tool|function|command|action|permission/iu.test(kind)) throw forbiddenToolUse(ANTIGRAVITY, `a ${kind.slice(0, 60)} event`);
      },
      finish(exitCode, stderr) {
        if (ANTIGRAVITY_DENIAL.test(stderr)) throw forbiddenToolUse(ANTIGRAVITY, `a tool call that was soft-denied (${stderr.split(/\r?\n/u).find((line) => ANTIGRAVITY_DENIAL.test(line))?.trim().slice(0, 80) ?? "stderr notice"})`);
        if (envelope === null) throw incomplete(ANTIGRAVITY, exitCode, stderr);
        const status = String(envelope["status"]).toUpperCase();
        const failure = `${text(envelope["error"]) ?? text(record(envelope["error"])?.["message"]) ?? ""}\n${stderr}`;
        if (status === "CANCELED" || status === "INTERRUPTED") throw new TransportError("HTTP", `CLI_INTERRUPTED: the Antigravity CLI reported ${status}`, true);
        if (status === "INVALID") throw new TransportError("INVALID_REQUEST", `CLI_REQUEST_INVALID: the Antigravity CLI refused the request: ${failure.trim().slice(0, 240)}`, false);
        if (status !== "SUCCESS" || exitCode !== 0) throw classifyCliFailure(ANTIGRAVITY, failure, exitCode === 0 ? 1 : exitCode);
        const structured = envelope["structured_output"];
        const present = structured !== undefined && structured !== null;
        // With a schema the answer is `structured_output`; `response` then carries narration and
        // internal tool records. Known CLI defect (antigravity-cli#1065): --json-schema can report
        // SUCCESS with no structured output, which is never a success.
        if (context.nativeSchema && !present) throw new TransportError("MALFORMED_RESPONSE", "CLI_EMPTY_SUCCESS: the Antigravity CLI reported SUCCESS without structured output", false);
        const reply = context.nativeSchema ? JSON.stringify(structured) : (text(envelope["response"]) ?? streamed).replace(/\n$/u, "");
        if (reply.trim() === "") throw new TransportError("MALFORMED_RESPONSE", "CLI_EMPTY_SUCCESS: the Antigravity CLI reported SUCCESS with an empty response", false);
        const usage = record(envelope["usage"]);
        const input = count(usage?.["input_tokens"]); const output = count(usage?.["output_tokens"]); const thinking = count(usage?.["thinking_tokens"]);
        // agy 1.3.3 counts thinking inside output_tokens (total_tokens is input_tokens + output_tokens, observed
        // live); adding it again nearly doubled Gemini's reported output. Where the total does not show that,
        // thinking is added: over-counting keeps the run budget conservative.
        const thinkingInOutput = input !== null && output !== null && count(usage?.["total_tokens"]) === input + output;
        return { text: reply, sessionId: text(envelope["conversation_id"]), ...(present ? { structured } : {}),
          usage: { inputTokens: input, outputTokens: output === null ? null : output + (thinkingInOutput ? 0 : thinking ?? 0), cacheReadTokens: count(usage?.["cache_read_tokens"]), cacheWriteTokens: null } };
      },
    };
  },
};

export const CLI_DIALECTS: Readonly<Record<string, CliDialect>> = Object.freeze({ "claude-code-cli": claudeCodeDialect, "codex-cli": codexDialect, "gemini-cli": geminiDialect, "antigravity-cli": antigravityDialect });
