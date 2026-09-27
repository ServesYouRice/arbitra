import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliVendor } from "./support.js";

/**
 * Scripted stand-in for a subscription CLI (Claude Code, Codex or Gemini), for tests where
 * no real CLI or login exists. It is a real child process that answers the version and auth
 * status commands, reads its prompt from stdin and emits the event stream the vendor's
 * reader expects, including forbidden tool events, limit messages, malformed output and
 * hangs with a descendant process. It proves arbitra's handling of those cases; only the
 * recorded live runs prove the real CLIs emit this format.
 */
export type CliStandInReply =
  | { readonly kind: "text"; readonly text: string; readonly usage?: false }
  | { readonly kind: "tool_use" }
  | { readonly kind: "not_logged_in" }
  | { readonly kind: "usage_limit" }
  | { readonly kind: "rate_limit" }
  | { readonly kind: "malformed" }
  | { readonly kind: "output_limit" }
  | { readonly kind: "hang" }
  /** Antigravity only: a tool call soft-denied on stderr, a SUCCESS with an empty response, or a run waiting for approval. */
  | { readonly kind: "soft_denied" }
  | { readonly kind: "empty_success" }
  | { readonly kind: "waiting" };

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
  const schemaFile = args[args.indexOf("--output-schema") + 1];
  if (s.reportFile) fs.writeFileSync(s.reportFile + "." + index, JSON.stringify({ cwd: process.cwd(), argv: args, env: process.env, stdin: s.vendor === "antigravity" ? args[args.indexOf("-p") + 1] : stdin,
    files: fs.readdirSync(process.cwd()).sort(), geminiSettings: fs.existsSync(".gemini/settings.json") ? JSON.parse(fs.readFileSync(".gemini/settings.json", "utf8")) : null,
    system: s.vendor === "gemini" ? fs.readFileSync(process.env.GEMINI_SYSTEM_MD, "utf8") : args.includes("--system-prompt-file") ? fs.readFileSync(systemFile, "utf8") : null,
    schema: args.includes("--output-schema") ? JSON.parse(fs.readFileSync(schemaFile, "utf8")) : null }));
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
    out({ type: "thread.started", thread_id: "stand-in-thread-" + index }); out({ type: "turn.started" });
    switch (reply.kind) {
      case "text": out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
        out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: reply.text } });
        out({ type: "turn.completed", usage: reply.usage === false ? undefined : { input_tokens: 12, cached_input_tokens: 4, output_tokens: 6, reasoning_output_tokens: 1 } }); process.exit(0);
      case "tool_use": out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "ls", status: "in_progress" } }); return hang();
      case "not_logged_in": process.stderr.write("Error: Not logged in. Run codex login\n"); process.exit(1);
      case "usage_limit": out({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes." } }); process.exit(1);
      case "rate_limit": out({ type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests, retry in 20s" }); out({ type: "turn.failed", error: { message: "429 Too Many Requests" } }); process.exit(1);
      case "malformed": out("{not json"); process.exit(0);
      case "output_limit": case "hang": return hang();
    }
  }
  if (s.vendor === "antigravity") {
    const conversation = "stand-in-conversation-" + index;
    const result = (fields) => out({ event: "result", result: { conversation_id: conversation, duration_seconds: 1, num_turns: 1, ...fields } });
    const envelope = (status, extra) => { result({ status, ...extra }); process.exit(status === "SUCCESS" ? 0 : 1); };
    const step = (fields) => out({ event: "step_update", step_update: { conversation_id: conversation, state: "DONE", ...fields } });
    out({ event: "init", conversation_id: conversation, init: { model: args[args.indexOf("--model") + 1], tools: ["run_command", "browser_click_element"] } });
    step({ step_index: 0, step_type: "user_input" });
    switch (reply.kind) {
      case "text": { const schema = args.includes("--json-schema"); step({ step_index: 1, step_type: "agent_response", text_delta: reply.text + "\n" }); step({ step_index: 2, step_type: "finish" });
        return envelope("SUCCESS", { response: reply.text, ...(schema ? { structured_output: JSON.parse(reply.text) } : {}), ...(reply.usage === false ? {} : { usage: { input_tokens: 30, output_tokens: 8, thinking_tokens: 2, cache_read_tokens: 10, total_tokens: 40 } }) }); }
      case "tool_use": step({ step_index: 1, step_type: "run_command", state: "ACTIVE" }); return hang();
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
