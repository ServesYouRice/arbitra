import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliVendor } from "./support.js";

/**
 * Scripted stand-in for a subscription CLI (Claude Code, Codex, Gemini or Antigravity), for
 * tests where no real CLI or login exists. It is a real child process that answers the version
 * and auth status commands, reads its prompt where the real CLI does (stdin, or the
 * Antigravity CLI's `-p` argument) and emits the event stream the vendor's reader expects,
 * including forbidden tool events, limit messages, malformed output and hangs with a
 * descendant process. It proves arbitra's handling of those cases; only the recorded live
 * runs prove the real CLIs emit this format.
 */
export type CliStandInReply =
  | { readonly kind: "text"; readonly text: string; readonly usage?: false | "thinking_in_output"; /** Antigravity only: a line the CLI writes to stderr first. */ readonly stderr?: string }
  | { readonly kind: "tool_use" }
  | { readonly kind: "not_logged_in" }
  | { readonly kind: "usage_limit" }
  | { readonly kind: "rate_limit" }
  | { readonly kind: "malformed" }
  | { readonly kind: "output_limit" }
  | { readonly kind: "hang" }
  /** Antigravity only: the CLI's own error step for a failed model call. Its text, when given, is stored where the real CLI keeps it. */
  | { readonly kind: "model_error"; readonly text?: string }
  /** Antigravity only: a step of type `unknown` that names a tool, unlike the bare one agy 1.4.7 sends before every answer. */
  | { readonly kind: "unknown_tool_step" }
  /** Antigravity only: a tool call soft-denied on stderr, a SUCCESS with an empty response, or a run waiting for approval. */
  | { readonly kind: "soft_denied" }
  | { readonly kind: "empty_success" }
  | { readonly kind: "waiting" }
  /** Codex only: a configuration setting it ignores, reported as an error item, then an ordinary answer. */
  | { readonly kind: "ignored_setting" }
  /** Codex only: the service refusing a model the CLI or the plan does not serve (observed live on 0.158.0-alpha.2.1 for gpt-6.1-sol). */
  | { readonly kind: "model_unavailable" };

export interface CliStandInScenario {
  readonly vendor: CliVendor;
  readonly version?: string;
  readonly auth?: "logged_in" | "not_logged_in" | "api_key";
  /** Replies in call order; the last one repeats. */
  readonly replies?: readonly CliStandInReply[];
  /** Per call, `<reportFile>.<index>` receives {cwd, argv, env, stdin, files, control}. */
  readonly reportFile?: string;
  readonly stateFile?: string;
  /** Where a hanging stand-in writes the PID of the descendant it spawns. */
  readonly pidFile?: string;
}

/**
 * Written as a `.cjs` entry point by default, so it runs as `node <script>` through the
 * executable override. Executing a freshly written file directly is slow and occasionally
 * stalls for about 25 s on macOS while the system assesses the new executable, and Node's
 * spawn blocks the event loop for that time; that made timing-sensitive tests flaky.
 * Pass a bare `name` only where a test needs PATH discovery of the command itself.
 */
export async function writeCliStandIn(directory: string, scenario: CliStandInScenario, name: string = `${{ "claude-code": "claude", codex: "codex", gemini: "gemini", antigravity: "agy" }[scenario.vendor]}.cjs`): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${SOURCE.replace("__SCENARIO__", () => JSON.stringify({ stateFile: join(directory, `${name}.state`), ...scenario }))}`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

const SOURCE = String.raw`"use strict";
const fs = require("node:fs"); const path = require("node:path"); const cp = require("node:child_process");
const s = __SCENARIO__;
const args = process.argv.slice(2);
const out = (value) => fs.writeSync(1, (typeof value === "string" ? value : JSON.stringify(value)) + "\n");
const version = s.version ?? { "claude-code": "2.1.282", codex: "0.154.0", gemini: "0.61.0", antigravity: "1.2.0" }[s.vendor];
const auth = s.auth ?? "logged_in";
if (args[0] === "--version") { out(s.vendor === "claude-code" ? version + " (Claude Code)" : s.vendor === "codex" ? "codex-cli " + version : s.vendor === "antigravity" ? "agy " + version : version); process.exit(0); }
if (s.vendor === "claude-code" && args[0] === "auth") { out({ loggedIn: auth !== "not_logged_in", authMethod: auth === "api_key" ? "api_key" : "claude.ai", subscriptionType: "max" }); process.exit(0); }
if (s.vendor === "codex" && args[0] === "login") {
  if (auth === "not_logged_in") { process.stderr.write("Not logged in\n"); process.exit(1); }
  process.stderr.write(auth === "api_key" ? "Logged in using an API key - sk-proj-***\n" : "Logged in using ChatGPT\n"); process.exit(0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", run);
function next() {
  let index = 0;
  try { index = Number(fs.readFileSync(s.stateFile, "utf8")) || 0; } catch {}
  fs.writeFileSync(s.stateFile, String(index + 1));
  const replies = s.replies ?? [{ kind: "text", text: "stand-in reply" }];
  return { index, reply: replies[Math.min(index, replies.length - 1)] };
}
function hang() {
  const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (s.pidFile) fs.writeFileSync(s.pidFile, String(child.pid));
  setInterval(() => {}, 1000);
}
function control(dir) { try { return Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])); } catch { return {}; } }
function run() {
  const { index, reply } = next();
  const systemFile = args[args.indexOf("--system-prompt-file") + 1];
  // The Antigravity CLI names its schema file with --json-schema (stdin prompts only); Codex with --output-schema.
  const schemaFlag = s.vendor === "antigravity" ? "--json-schema" : "--output-schema";
  const schemaFile = args[args.indexOf(schemaFlag) + 1];
  // The Antigravity CLI takes its prompt as the -p argument or, with --input-format stream-json, as one message per stdin line.
  const streamInput = s.vendor === "antigravity" && args[args.indexOf("--input-format") + 1] === "stream-json" && args.includes("--input-format");
  let message = null;
  if (streamInput) { try { message = JSON.parse(stdin.split("\n")[0]); } catch {} }
  const prompt = s.vendor !== "antigravity" ? stdin : streamInput ? message?.message?.content ?? null : args[args.indexOf("-p") + 1];
  if (s.reportFile) fs.writeFileSync(s.reportFile + "." + index, JSON.stringify({ cwd: process.cwd(), argv: args, env: process.env, stdin: prompt,
    files: fs.readdirSync(process.cwd()).sort(), geminiSettings: fs.existsSync(".gemini/settings.json") ? JSON.parse(fs.readFileSync(".gemini/settings.json", "utf8")) : null,
    system: s.vendor === "gemini" ? fs.readFileSync(process.env.GEMINI_SYSTEM_MD, "utf8") : args.includes("--system-prompt-file") ? fs.readFileSync(systemFile, "utf8")
      : s.vendor === "codex" && args.some((value) => value.startsWith("model_instructions_file=")) ? fs.readFileSync(JSON.parse(args.find((value) => value.startsWith("model_instructions_file=")).slice("model_instructions_file=".length)), "utf8") : null,
    schema: args.includes(schemaFlag) && fs.existsSync(schemaFile) ? JSON.parse(fs.readFileSync(schemaFile, "utf8")) : null }));
  // agy 1.3.3 accepts only {"event":"user","message":{"content":...}} and answers anything else with an ERROR result;
  // the stand-in also refuses a -p beside it, which the dialect never sends.
  if (streamInput && (args.includes("-p") || message?.event !== "user" || typeof message.message?.content !== "string")) {
    out({ event: "result", result: { status: "ERROR", response: "", error: "stream input \"user\" message has no content", num_turns: 0 } });
    process.exit(1);
  }
  const reset = Math.floor(Date.now() / 1000) + 3600;
  if (s.vendor === "claude-code") {
    const session = "stand-in-session-" + index;
    out({ type: "system", subtype: "init", session_id: session, tools: args.includes("--json-schema") ? ["StructuredOutput"] : [], mcp_servers: [], apiKeySource: "none", model: args[args.indexOf("--model") + 1] });
    const result = (isError, text, extra = {}) => { out({ type: "result", subtype: "success", is_error: isError, result: text, session_id: session, num_turns: 1, ...extra }); process.exit(isError ? 1 : 0); };
    switch (reply.kind) {
      case "text": out({ type: "assistant", message: { content: [{ type: "text", text: reply.text }] }, session_id: session });
        return result(false, reply.text, reply.usage === false ? {} : { usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 5 }, total_cost_usd: 0.01 });
      case "tool_use": out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] }, session_id: session }); return hang();
      case "not_logged_in": return result(true, "Not logged in · Please run /login");
      case "usage_limit": out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: reset, rateLimitType: "five_hour" } }); return result(true, "Claude AI usage limit reached|" + reset);
      case "rate_limit": return result(true, "API Error: 429 rate_limit_error: Too many requests, retry in 30 seconds");
      case "malformed": out("this is not json"); process.exit(0);
      case "output_limit": out({ type: "user", isSynthetic: true, message: { role: "user", content: [{ type: "text", text: "Output token limit hit. Resume directly" }] } }); return hang();
      case "hang": return hang();
    }
  }
  if (s.vendor === "codex") {
    // "exec resume <thread> -" continues a stored session, which then reports the usage of all its turns so far.
    // Codex stores a session as sessions/<year>/<month>/<day>/rollout-<time>-<thread>.jsonl under its home.
    const resumed = args[1] === "resume";
    const thread = resumed ? args[args.length - 2] : "stand-in-thread-" + index;
    const today = new Date(); const pad = (value) => String(value).padStart(2, "0");
    const sessions = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE, ".codex"), "sessions", String(today.getFullYear()), pad(today.getMonth() + 1), pad(today.getDate()));
    const rollout = path.join(sessions, "rollout-" + today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate()) + "T00-00-00-" + thread + ".jsonl");
    if (resumed && !fs.existsSync(rollout)) { process.stderr.write("Error: thread not found\n"); process.exit(1); }
    if (!args.includes("--ephemeral") && !resumed) { fs.mkdirSync(sessions, { recursive: true }); fs.writeFileSync(rollout, ""); }
    out({ type: "thread.started", thread_id: thread });
    // Codex 0.162 reports a configuration setting it ignores as an error item before the turn (observed live).
    if (reply.kind === "ignored_setting") out({ type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n  session-flags: 'base_instructions' is ignored." } });
    out({ type: "turn.started" });
    switch (reply.kind) {
      case "text": out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
        out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: reply.text } });
        out({ type: "turn.completed", usage: reply.usage === false ? undefined : resumed ? { input_tokens: 30, cached_input_tokens: 20, output_tokens: 9, reasoning_output_tokens: 2 } : { input_tokens: 12, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 1 } }); process.exit(0);
      case "ignored_setting": out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "NONE" } }); out({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 6 } }); process.exit(0);
      case "tool_use": out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "ls", status: "in_progress" } }); return hang();
      case "not_logged_in": process.stderr.write("Error: Not logged in. Run codex login\n"); process.exit(1);
      case "model_unavailable": process.stderr.write("ERROR: " + JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", code: "model_not_found" } }) + "\n");
        out({ type: "turn.failed", error: { message: "model_not_found" } }); process.exit(1);
      case "usage_limit": out({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes." } }); process.exit(1);
      case "rate_limit": out({ type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests, retry in 20s" }); out({ type: "turn.failed", error: { message: "429 Too Many Requests" } }); process.exit(1);
      case "malformed": out("{not json"); process.exit(0);
      case "output_limit": case "hang": return hang();
    }
  }
  if (s.vendor === "antigravity") {
    // --conversation <id> continues a stored conversation, which then reports the usage of all its turns so far.
    const continued = args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : null;
    const conversation = continued ?? "stand-in-conversation-" + index;
    const stored = path.join(process.env.HOME ?? process.env.USERPROFILE, ".gemini", "antigravity-cli", "conversations", conversation + ".db");
    if (continued !== null && !fs.existsSync(stored)) { out({ event: "result", result: { status: "ERROR", response: "", error: "conversation not found" } }); process.exit(1); }
    if (continued === null && reply.kind === "text") { fs.mkdirSync(path.dirname(stored), { recursive: true }); fs.writeFileSync(stored, ""); }
    const result = (fields) => out({ event: "result", result: { conversation_id: conversation, duration_seconds: 1, num_turns: 1, ...fields } });
    const envelope = (status, extra) => { result({ status, ...extra }); process.exit(status === "SUCCESS" ? 0 : 1); };
    const step = (fields) => out({ event: "step_update", step_update: { conversation_id: conversation, state: "DONE", ...fields } });
    out({ event: "init", conversation_id: conversation, init: { model: args[args.indexOf("--model") + 1], tools: ["run_command", "browser_click_element"] } });
    step({ step_index: 0, step_type: "user_input" });
    // A continued conversation starts with the CLI's own notice (agy 1.3.5: "All your subagents and background tasks
    // have been stopped due to server restart. ...").
    if (continued !== null) step({ step_index: 1, step_type: "system_message", duration_seconds: 0 });
    switch (reply.kind) {
      // agy 1.4.7 streams a bare step of type "unknown" before the answer of every plain reply (observed live).
      case "text": { if (typeof reply.stderr === "string") process.stderr.write(reply.stderr + "\n"); const schema = args.includes("--json-schema"); step({ step_index: 1, step_type: "unknown", duration_seconds: 0.000287 }); step({ step_index: 2, step_type: "agent_response", text_delta: reply.text + "\n" }); step({ step_index: 3, step_type: "finish" });
        return envelope("SUCCESS", { response: reply.text, ...(schema ? { structured_output: JSON.parse(reply.text) } : {}), ...(reply.usage === false ? {} : { usage: reply.usage === "thinking_in_output" ? { input_tokens: 30, output_tokens: 8, thinking_tokens: 6, cache_read_tokens: 0, total_tokens: 38 }
          : continued !== null ? { input_tokens: 45, output_tokens: 15, thinking_tokens: 3, cache_read_tokens: 40, total_tokens: 63 } : { input_tokens: 30, output_tokens: 8, thinking_tokens: 2, cache_read_tokens: 10, total_tokens: 40 } }) }); }
      // The shape agy 1.3.3 streams for a failed model call (observed live): the step carries no text. The reason is a
      // string inside a protobuf payload in the CLI's conversation database, and the CLI then retries by itself.
      case "model_error": {
        if (typeof reply.text === "string") {
          const { DatabaseSync } = require("node:sqlite");
          const directory = path.join(process.env.HOME ?? process.env.USERPROFILE, ".gemini", "antigravity-cli", "conversations");
          fs.mkdirSync(directory, { recursive: true });
          const database = new DatabaseSync(path.join(directory, conversation + ".db"));
          database.exec("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)");
          database.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)").run(1, 17, Buffer.concat([Buffer.from([98, 36]), Buffer.from("070bfd30-3c8c-4839-b4f1-e13cf43b0ce4"), Buffer.from([18, 3, 8, 1, 26]), Buffer.from(reply.text), Buffer.from([10, 0])]));
          database.close();
        }
        step({ step_index: 1, step_type: "error_message", duration_seconds: 0 }); return hang();
      }
      // The shape agy 1.2.14 streams for its own tool step (observed live).
      case "tool_use": step({ step_index: 1, step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls -la" } } }); return hang();
      case "unknown_tool_step": step({ step_index: 1, step_type: "unknown", state: "ACTIVE", tool_name: "run_command" }); return hang();
      case "soft_denied": process.stderr.write("Tool run_command requires approval and was denied in headless mode\n"); result({ status: "SUCCESS", response: "I could not run the command." }); process.exit(0);
      case "empty_success": result({ status: "SUCCESS", response: "" }); process.exit(0);
      case "waiting": result({ status: "WAITING", response: "" }); return hang();
      case "not_logged_in": return envelope("ERROR", { error: "Not signed in. Run agy to sign in with Google." });
      case "usage_limit": return envelope("ERROR", { error: "Quota exhausted for your Google AI Pro plan. Your quota refreshes in 3 hours." });
      case "rate_limit": return envelope("ERROR", { error: "429 Too Many Requests: rate limited, retry in 20s" });
      case "malformed": out("not json at all"); process.exit(0);
      case "output_limit": case "hang": return hang();
    }
  }
  if (s.vendor === "gemini") {
    out({ type: "init", session_id: "stand-in-gemini-" + index, model: args[args.indexOf("--model") + 1] });
    switch (reply.kind) {
      case "text": { const half = Math.floor(reply.text.length / 2);
        out({ type: "message", role: "assistant", content: reply.text.slice(0, half), delta: true }); out({ type: "message", role: "assistant", content: reply.text.slice(half), delta: true });
        out({ type: "result", status: "success", stats: reply.usage === false ? {} : { input_tokens: 20, output_tokens: 7, cached: 5, total_tokens: 27 } }); process.exit(0); }
      case "tool_use": out({ type: "tool_use", tool_name: "run_shell_command", tool_id: "t1", parameters: { command: "ls" } }); return hang();
      case "not_logged_in": process.stderr.write("Please set an Auth method in your ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY\n"); process.exit(41);
      case "usage_limit": out({ type: "result", status: "error", error: { type: "Error", message: "You have exhausted your daily quota on this model." }, stats: {} }); process.exit(1);
      case "rate_limit": out({ type: "error", severity: "error", message: "[API Error: 429 RESOURCE_EXHAUSTED] Please retry in 23.5s" }); out({ type: "result", status: "error", error: { type: "Error", message: "429" }, stats: {} }); process.exit(1);
      case "malformed": out("<html>not json</html>"); process.exit(0);
      case "output_limit": case "hang": return hang();
    }
  }
}
`;
