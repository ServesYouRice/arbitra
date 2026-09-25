import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Scripted stand-in for a native harness executable, used by tests where no real
 * native CLI or credential exists. It is a real child process that answers
 * `--version`, reads its prompt from stdin and emits the stream-json schema the
 * Claude Code translation layer assumes, including malformed lines, crashes, hangs
 * with descendant processes, missing usage and forbidden tool calls. It proves the
 * adapter's handling of those cases; it does not prove the real CLI emits this schema.
 */
export type StandInStep =
  | { readonly write: string; readonly content: string; readonly tool?: string; readonly absolute?: boolean }
  | { readonly tool: string; readonly input: unknown }
  | { readonly raw: string }
  | { readonly text: string }
  | { readonly exit: number }
  | { readonly hang: true }
  | { readonly remove: string }
  /** Change a file without any tool event (a harness that edits files silently). */
  | { readonly silent: string; readonly content: string };

export interface StandInScenario {
  readonly version?: string;
  readonly model?: string;
  readonly mcpServers?: readonly unknown[];
  readonly steps: readonly StandInStep[];
  /** Final `result` event; `null` emits none. Default: success with measured usage and a JSON summary. */
  readonly result?: Record<string, unknown> | null;
  /** Omit usage from assistant messages (unknown usage). */
  readonly omitMessageUsage?: boolean;
  /** Where the stand-in writes {cwd, envKeys, argv, prompt} for isolation assertions. */
  readonly reportFile?: string;
  /** Where a hanging stand-in writes the PID of the descendant it spawns. */
  readonly pidFile?: string;
  readonly exitCode?: number;
}

export async function writeStandInExecutable(directory: string, scenario: StandInScenario, name = "claude"): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${STAND_IN_SOURCE.replace("__SCENARIO__", () => JSON.stringify(scenario))}`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

/**
 * Whether a process has terminated. A killed descendant is reparented and reaped
 * asynchronously, and until then `kill(pid, 0)` still succeeds on its zombie entry, so a
 * zombie (`ps` state Z) counts as terminated. Polls for up to `timeoutMs`.
 */
export async function processTerminated(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; }
    if (process.platform !== "win32") {
      try { if (execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z")) return true; }
      catch { return true; }
    }
    if (Date.now() > deadline) return false;
    await new Promise((wake) => setTimeout(wake, 20));
  }
}

const STAND_IN_SOURCE = String.raw`"use strict";
const fs = require("node:fs"); const path = require("node:path"); const cp = require("node:child_process");
const scenario = __SCENARIO__;
const args = process.argv.slice(2);
const emit = (value) => fs.writeSync(1, (typeof value === "string" ? value : JSON.stringify(value)) + "\n");
if (args[0] === "--version") { emit((scenario.version ?? "2.1.0") + " (Claude Code)"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", run);
function usage() { return scenario.omitMessageUsage ? undefined : { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }; }
function run() {
  if (scenario.reportFile) fs.writeFileSync(scenario.reportFile, JSON.stringify({ cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), env: { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }, argv: args, prompt, files: fs.readdirSync(process.cwd()).sort() }));
  emit({ type: "system", subtype: "init", session_id: "stand-in-session", model: scenario.model ?? "stand-in-model", cwd: process.cwd(), tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], mcp_servers: scenario.mcpServers ?? [] });
  let turn = 0;
  const assistant = (content) => { turn += 1; const message = { id: "msg_" + turn, type: "message", role: "assistant", model: scenario.model ?? "stand-in-model", content }; const u = usage(); if (u) message.usage = u; emit({ type: "assistant", message, parent_tool_use_id: null, session_id: "stand-in-session" }); };
  const toolResult = (id, content) => emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: null, session_id: "stand-in-session" });
  for (const step of scenario.steps) {
    if (step.write !== undefined) {
      const id = "toolu_" + (turn + 1);
      const target = step.absolute ? path.join(process.cwd(), step.write) : step.write;
      assistant([{ type: "tool_use", id, name: step.tool ?? "Write", input: { file_path: target, content: step.content } }]);
      fs.mkdirSync(path.dirname(path.join(process.cwd(), step.write)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), step.write), step.content);
      toolResult(id, "File written");
    } else if (step.silent !== undefined) {
      fs.mkdirSync(path.dirname(path.join(process.cwd(), step.silent)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), step.silent), step.content);
    } else if (step.remove !== undefined) {
      fs.rmSync(path.join(process.cwd(), step.remove));
    } else if (step.tool !== undefined) {
      const id = "toolu_" + (turn + 1);
      assistant([{ type: "tool_use", id, name: step.tool, input: step.input }]);
      toolResult(id, "ok");
    } else if (step.raw !== undefined) emit(step.raw);
    else if (step.text !== undefined) assistant([{ type: "text", text: step.text }]);
    else if (step.exit !== undefined) process.exit(step.exit);
    else if (step.hang) {
      const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      if (scenario.pidFile) fs.writeFileSync(scenario.pidFile, String(child.pid));
      setInterval(() => {}, 1000);
      return;
    }
  }
  if (scenario.result !== null) emit(scenario.result ?? { type: "result", subtype: "success", is_error: false, num_turns: turn, session_id: "stand-in-session", total_cost_usd: 0.01,
    result: JSON.stringify({ summary: "Stand-in wrote the requested test", limitations: [] }), usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 40 } });
  process.exit(scenario.exitCode ?? 0);
}
`;
