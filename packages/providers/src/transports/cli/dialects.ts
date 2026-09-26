import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TransportError, type TransportRequest, type TransportUsage } from "../../transport-contract.js";
import type { CliPrompt } from "./prompt.js";
import { classifyCliFailure } from "./classify.js";
import { cliTransportSupport, type CliAuthMode, type CliTransportSupport } from "./support.js";

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

const CLAUDE = cliTransportSupport("claude-code-cli")!;
const CODEX = cliTransportSupport("codex-cli")!;
const GEMINI = cliTransportSupport("gemini-cli")!;

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
        if (result["is_error"] === true || exitCode !== 0) throw classifyCliFailure(CLAUDE, `${rejected ?? ""}\n${reply}\n${String(result["api_error_status"] ?? "")}\n${stderr}`, exitCode);
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

export const CLI_DIALECTS: Readonly<Record<string, CliDialect>> = Object.freeze({ "claude-code-cli": claudeCodeDialect, "codex-cli": codexDialect, "gemini-cli": geminiDialect });
