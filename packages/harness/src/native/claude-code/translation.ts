/*
 * ============================================================================
 *  UNVERIFIED TRANSLATION LAYER — Claude Code headless (`claude -p`) stream-json
 * ============================================================================
 *
 * Everything in this file encodes arbitra's reading of Claude Code's documented
 * headless CLI: command-line flags, environment variables, `--version` output and the
 * `--output-format stream-json` event schema. It was written from public
 * documentation and has NOT been exercised against a real `claude` binary; the
 * adapter's tests drive a scripted stand-in executable that emits this schema.
 *
 * Keep all harness-specific assumptions here, so that the opt-in conformance test
 * (`ARBITRA_NATIVE_HARNESS_CONFORMANCE=1`) can confirm or correct them in one place.
 * `CLAUDE_CODE_TRANSLATION.verified` stays false until that run is recorded.
 *
 * Assumptions (each is a conformance checkpoint):
 *  A1 `claude --version` prints `<major>.<minor>.<patch>` first, e.g. `2.0.14 (Claude Code)`.
 *  A2 `-p` with no positional prompt reads the prompt from stdin.
 *  A3 `--output-format stream-json` with `-p` requires `--verbose` and writes one JSON
 *     object per line: `system`/`init`, `assistant`, `user` (tool results) and a final
 *     `result` event.
 *  A4 `--max-turns`, `--model`, `--allowedTools`, `--disallowedTools` and
 *     `--strict-mcp-config` exist; permission rules accept `Tool(./relative/path)`.
 *     In `-p` mode a tool call not covered by an allow rule is denied, not prompted.
 *  A5 `CLAUDE_CONFIG_DIR` relocates user settings, memory and sessions; `HOME` is
 *     honoured for `~`; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` disables updater,
 *     telemetry and error reporting; the API key is read from `ANTHROPIC_API_KEY`.
 *  A6 Project instructions are read from `CLAUDE.md`/`CLAUDE.local.md` files and the
 *     `.claude/` directory in and above the working directory; `.mcp.json` declares
 *     project MCP servers. arbitra never materializes those files for the harness.
 *  A7 `result.usage` uses Anthropic Messages buckets (`input_tokens`,
 *     `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`), which
 *     are disjoint; `result.subtype` is `success`, `error_max_turns` or
 *     `error_during_execution`.
 *  A8 Built-in tool names: Read, Glob, Grep, LS (read); Edit, MultiEdit, Write,
 *     NotebookEdit (write); Bash, BashOutput, KillShell (shell); WebFetch, WebSearch
 *     (network); Task (subagents); `mcp__*` (MCP). File tools take `file_path`
 *     (`notebook_path` for notebooks); Glob, Grep and LS take `path`.
 */
import type { HarnessUsage } from "../../adapter.js";

export const CLAUDE_CODE_TRANSLATION = Object.freeze({ id: "claude-code-stream-json", version: "1.0.0", verified: false });

export type NativeToolClass = "read" | "write" | "shell" | "network" | "subagent" | "mcp" | "unknown";

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** A8. Unknown tools are refused: a tool arbitra cannot classify cannot be bounded. */
export function claudeCodeToolClass(name: string): NativeToolClass {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  if (SHELL_TOOLS.has(name)) return "shell";
  if (NETWORK_TOOLS.has(name)) return "network";
  if (name === "Task") return "subagent";
  if (name.startsWith("mcp__")) return "mcp";
  return "unknown";
}

/** A6. Paths that would become harness instructions or configuration if materialized. */
export function isClaudeCodeControlPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.some((part) => part === ".claude") || ["CLAUDE.md", "CLAUDE.local.md", ".mcp.json"].includes(name);
}

/** A1. */
export function parseClaudeCodeVersion(stdout: string): string | null {
  const match = /^\s*v?(\d{1,6}\.\d{1,6}\.\d{1,6})(?:\s|$)/u.exec(stdout);
  return match?.[1] ?? null;
}
export const CLAUDE_CODE_VERSION_ARGUMENTS: readonly string[] = Object.freeze(["--version"]);

export interface ClaudeCodeInvocation {
  readonly model: string | null;
  readonly maximumTurns: number;
  /** Permitted tool names; write tools are scoped to the exact leased paths. */
  readonly tools: readonly string[];
  readonly writablePaths: readonly string[];
}

/** A2–A4. The prompt is sent on stdin, never in argv. */
export function claudeCodeArguments(invocation: ClaudeCodeInvocation): readonly string[] {
  const allowed: string[] = [];
  for (const tool of invocation.tools) {
    const kind = claudeCodeToolClass(tool);
    if (kind === "read") allowed.push(tool);
    else if (kind === "write") for (const path of invocation.writablePaths) allowed.push(`${tool}(./${path})`);
    else throw new Error(`NATIVE_HARNESS_TOOL_UNENFORCEABLE:${tool}`);
  }
  const denied = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch", "Task", "NotebookEdit"].filter((tool) => !invocation.tools.includes(tool));
  return Object.freeze([
    "-p", "--output-format", "stream-json", "--verbose",
    "--max-turns", String(invocation.maximumTurns),
    ...(invocation.model === null ? [] : ["--model", invocation.model]),
    "--allowedTools", allowed.join(","),
    "--disallowedTools", denied.join(","),
    "--strict-mcp-config",
  ]);
}

export interface ClaudeCodeEnvironmentInput {
  readonly host: Readonly<Record<string, string | undefined>>;
  readonly home: string; readonly configDirectory: string; readonly temporaryDirectory: string;
  readonly credentialTarget: string; readonly credential: string;
}

/** A5. Only these keys reach the native process; host credentials, proxies and tokens do not. */
export function claudeCodeEnvironment(input: ClaudeCodeEnvironmentInput): Readonly<Record<string, string>> {
  const passthrough = Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG"].flatMap((key) => input.host[key] === undefined ? [] : [[key, input.host[key] as string]]));
  return Object.freeze({
    ...passthrough,
    HOME: input.home, USERPROFILE: input.home, CLAUDE_CONFIG_DIR: input.configDirectory,
    TMPDIR: input.temporaryDirectory, TEMP: input.temporaryDirectory, TMP: input.temporaryDirectory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    NO_COLOR: "1",
    [input.credentialTarget]: input.credential,
  });
}

/** Paths a tool call names, for detection of reads outside the scratch copy and writes outside the lease (A8). */
export function claudeCodeToolPaths(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  const edits = record["edits"];
  if (Array.isArray(edits)) for (const edit of edits) if (typeof edit === "object" && edit !== null && typeof (edit as Record<string, unknown>)["file_path"] === "string") paths.push((edit as Record<string, string>)["file_path"] as string);
  return paths;
}

export type ClaudeCodeEvent =
  | { readonly kind: "init"; readonly sessionId: string | null; readonly model: string | null; readonly mcpServers: number; readonly tools: readonly string[] | null }
  | { readonly kind: "assistant"; readonly messageId: string | null; readonly text: string | null; readonly toolUses: readonly { readonly id: string; readonly name: string; readonly input: unknown }[]; readonly usage: HarnessUsage | null; readonly parentToolUseId: string | null }
  | { readonly kind: "tool_results"; readonly results: readonly { readonly toolUseId: string; readonly isError: boolean; readonly content: string }[] }
  | { readonly kind: "result"; readonly subtype: string; readonly isError: boolean; readonly text: string | null; readonly turns: number | null; readonly usage: HarnessUsage | null; readonly costUsd: number | null; readonly sessionId: string | null }
  /** Event types this translation does not interpret (for example system/compact_boundary). */
  | { readonly kind: "ignored"; readonly type: string };

export class NativeEventError extends Error {
  constructor(readonly detail: string) { super(`NATIVE_HARNESS_MALFORMED_EVENT:${detail}`); this.name = "NativeEventError"; }
}

/** A3/A7. One stdout line to one event. Invalid JSON or a known type with the wrong shape is malformed. */
export function parseClaudeCodeEvent(line: string): ClaudeCodeEvent {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new NativeEventError("invalid_json"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeEventError("not_an_object");
  const event = value as Record<string, unknown>;
  const type = event["type"];
  if (typeof type !== "string" || type === "") throw new NativeEventError("type_absent");
  if (type === "system") {
    if (event["subtype"] !== "init") return { kind: "ignored", type: `system/${String(event["subtype"])}` };
    const servers = event["mcp_servers"];
    if (servers !== undefined && !Array.isArray(servers)) throw new NativeEventError("init_mcp_servers");
    const tools = event["tools"];
    return { kind: "init", sessionId: optionalString(event["session_id"], "init_session_id"), model: optionalString(event["model"], "init_model"),
      mcpServers: Array.isArray(servers) ? servers.length : 0, tools: Array.isArray(tools) && tools.every((tool) => typeof tool === "string") ? tools as string[] : null };
  }
  if (type === "assistant") {
    const message = record(event["message"], "assistant_message");
    const content = message["content"];
    if (!Array.isArray(content)) throw new NativeEventError("assistant_content");
    let text: string | null = null; const toolUses: { id: string; name: string; input: unknown }[] = [];
    for (const block of content) {
      const part = record(block, "assistant_block");
      if (part["type"] === "text") text = `${text ?? ""}${requiredString(part["text"], "assistant_text")}`;
      else if (part["type"] === "tool_use") toolUses.push({ id: requiredString(part["id"], "tool_use_id"), name: requiredString(part["name"], "tool_use_name"), input: part["input"] ?? null });
    }
    return { kind: "assistant", messageId: optionalString(message["id"], "assistant_id"), text, toolUses,
      usage: message["usage"] === undefined ? null : usage(message["usage"]), parentToolUseId: optionalString(event["parent_tool_use_id"], "parent_tool_use_id") };
  }
  if (type === "user") {
    const message = record(event["message"], "user_message");
    const content = message["content"];
    if (typeof content === "string") return { kind: "tool_results", results: [] };
    if (!Array.isArray(content)) throw new NativeEventError("user_content");
    const results = content.flatMap((block) => {
      const part = record(block, "user_block");
      if (part["type"] !== "tool_result") return [];
      return [{ toolUseId: requiredString(part["tool_use_id"], "tool_result_id"), isError: part["is_error"] === true, content: resultContent(part["content"]) }];
    });
    return { kind: "tool_results", results };
  }
  if (type === "result") {
    const subtype = requiredString(event["subtype"], "result_subtype");
    const turns = event["num_turns"];
    const cost = event["total_cost_usd"];
    return { kind: "result", subtype, isError: event["is_error"] === true || subtype !== "success", text: optionalString(event["result"], "result_text"),
      turns: typeof turns === "number" && Number.isSafeInteger(turns) && turns >= 0 ? turns : null,
      usage: event["usage"] === undefined || event["usage"] === null ? null : usage(event["usage"]),
      costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null, sessionId: optionalString(event["session_id"], "result_session_id") };
  }
  return { kind: "ignored", type };
}

/** A7. Disjoint buckets normalized to total input; any unreported bucket leaves the total unknown. */
function usage(value: unknown): HarnessUsage {
  const bucket = record(value, "usage");
  const count = (key: string): number | null | undefined => {
    const raw = bucket[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return null;
    return raw;
  };
  const input = count("input_tokens"); const output = count("output_tokens");
  const cacheRead = count("cache_read_input_tokens"); const cacheWrite = count("cache_creation_input_tokens");
  const complete = input !== undefined && input !== null && cacheRead !== null && cacheWrite !== null;
  return { inputTokens: complete ? input + (cacheRead ?? 0) + (cacheWrite ?? 0) : null, outputTokens: output ?? null,
    cacheReadTokens: cacheRead ?? null, cacheWriteTokens: cacheWrite ?? null };
}
function resultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => typeof part === "object" && part !== null && typeof (part as Record<string, unknown>)["text"] === "string" ? (part as Record<string, string>)["text"] : "").join("");
  return value === undefined || value === null ? "" : JSON.stringify(value);
}
function record(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeEventError(detail);
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, detail: string): string {
  if (typeof value !== "string") throw new NativeEventError(detail);
  return value;
}
function optionalString(value: unknown, detail: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new NativeEventError(detail);
  return value;
}
