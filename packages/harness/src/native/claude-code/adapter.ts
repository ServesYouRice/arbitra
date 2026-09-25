import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HarnessAdapter, HarnessEvent, HarnessNode, HarnessPrompt, HarnessRun, HarnessRunPolicy, HarnessToolDefinition, HarnessToolRuntime, HarnessUsage } from "../../adapter.js";
import { assertHarnessCompatible, assertRoundZeroPolicy, type HarnessProfile } from "../../profile.js";
import { runNativeProcess, type NativeProcessPort, type NativeProcessResult } from "../process.js";
import { CLAUDE_CODE_TESTING_WRITER_PROFILE } from "../support.js";
import { claudeCodeArguments, claudeCodeToolClass, claudeCodeToolPaths, NativeEventError, parseClaudeCodeEvent, type ClaudeCodeEvent } from "./translation.js";

/** One native run: an isolated scratch working directory, a sanitized environment and hard bounds. */
export interface NativeInvocation {
  readonly executable: string;
  /** Scratch copy the native process runs in. Never the Testing worktree. */
  readonly cwd: string;
  /** Additional spellings of `cwd` (for example its realpath) that tool paths may use. */
  readonly cwdAliases?: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly model: string | null;
  readonly maximumTurns: number;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  /** Lower-bound streamed usage above which the process is stopped. */
  readonly maximumTokens: number;
  /** Exact relative paths write tools may target (the write lease). */
  readonly writablePaths: readonly string[];
  readonly processes?: NativeProcessPort;
  readonly onSpawn?: (pid: number) => void;
}

/** Failure with everything observed before it. `usage` is the harness-reported total or null (unknown). */
export class NativeHarnessError extends Error {
  constructor(readonly code: string, readonly observed: { readonly usage: HarnessUsage | null; readonly process: Omit<NativeProcessResult, "stdout"> | null }) {
    super(code); this.name = "NativeHarnessError";
  }
}

/**
 * Claude Code headless adapter. It is a tool-loop harness, not an orchestrator: one
 * invocation is one activity under the existing Testing writer node. The native harness
 * executes its own tools inside the scratch copy, so `toolRuntime` is never called;
 * `tools` names the native tools the task grants, and every observed tool call is
 * checked against them (and against the write lease) as it streams. A violation stops
 * the whole process tree; no output of a stopped run is admitted by the caller.
 */
export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly profile: HarnessProfile = CLAUDE_CODE_TESTING_WRITER_PROFILE;
  constructor(private readonly invocation: NativeInvocation) {}

  run(node: HarnessNode, prompt: HarnessPrompt, tools: readonly HarnessToolDefinition[], _toolRuntime: HarnessToolRuntime, policy: HarnessRunPolicy): HarnessRun {
    assertHarnessCompatible(this.profile, policy.mode, policy.requirements);
    if (policy.round === 0) assertRoundZeroPolicy(this.profile);
    if (policy.mode !== "testing") throw new Error(`NATIVE_HARNESS_MODE_UNSUPPORTED:${policy.mode}`);
    if (!Number.isSafeInteger(node.maxToolTurns) || node.maxToolTurns < 0) throw new Error("INVALID_MODEL_TOOL_LOOP_LIMIT");
    const names = tools.map(({ name }) => name);
    for (const name of names) { const kind = claudeCodeToolClass(name); if (kind !== "read" && kind !== "write") throw new Error(`NATIVE_HARNESS_TOOL_UNENFORCEABLE:${name}`); }
    if (!isAbsolute(this.invocation.cwd)) throw new Error("NATIVE_HARNESS_CWD_NOT_ABSOLUTE");
    const argv = claudeCodeArguments({ model: this.invocation.model, maximumTurns: this.invocation.maximumTurns, tools: names, writablePaths: this.invocation.writablePaths });
    return Object.freeze({ events: this.execute(node, prompt, names, argv, policy) });
  }

  private async *execute(node: HarnessNode, prompt: HarnessPrompt, tools: readonly string[], argv: readonly string[], policy: HarnessRunPolicy): AsyncGenerator<HarnessEvent> {
    const queue: HarnessEvent[] = []; let notify: (() => void) | null = null; let finished = false;
    const push = (event: HarnessEvent) => { queue.push(Object.freeze(event)); notify?.(); };
    const state = { turn: -1, toolCalls: 0, messages: new Map<string, number>(), result: null as Extract<ClaudeCodeEvent, { kind: "result" }> | null };
    const roots = [this.invocation.cwd, ...(this.invocation.cwdAliases ?? [])];
    const writable = new Set(this.invocation.writablePaths);
    const onLine = (line: string) => {
      if (state.result !== null) throw new Error("NATIVE_HARNESS_EVENT_AFTER_RESULT");
      const event = parseClaudeCodeEvent(line);
      if (event.kind === "init") {
        if (event.mcpServers > 0) throw new Error("NATIVE_HARNESS_MCP_ACTIVE");
        push({ type: "harness_started", nodeId: node.id, harnessId: this.profile.id, sessionId: event.sessionId, model: event.model });
      } else if (event.kind === "assistant") {
        if (event.parentToolUseId !== null) throw new Error("NATIVE_HARNESS_SUBAGENT_ACTIVE");
        const key = event.messageId ?? `anonymous-${state.messages.size}`;
        if (!state.messages.has(key)) {
          state.turn += 1; state.messages.set(key, 0);
          if (state.messages.size > this.invocation.maximumTurns) throw new Error(`NATIVE_HARNESS_TURN_LIMIT:${this.invocation.maximumTurns}`);
          push({ type: "model_turn_started", nodeId: node.id, turn: state.turn });
        }
        if (event.usage !== null) {
          // Streamed per-message usage is only a lower bound; the result event carries the total.
          state.messages.set(key, Math.max(state.messages.get(key) ?? 0, (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0)));
          const observed = [...state.messages.values()].reduce((sum, value) => sum + value, 0);
          if (observed > this.invocation.maximumTokens) throw new Error(`NATIVE_HARNESS_TOKEN_LIMIT:${this.invocation.maximumTokens}`);
          push({ type: "model_turn_completed", nodeId: node.id, turn: state.turn, usage: event.usage });
        }
        for (const use of event.toolUses) {
          state.toolCalls += 1;
          const call = { id: use.id, name: use.name, arguments: use.input };
          push({ type: "tool_call", nodeId: node.id, turn: state.turn, call });
          if (!tools.includes(use.name)) throw new Error(`NATIVE_HARNESS_TOOL_NOT_PERMITTED:${use.name}`);
          if (state.toolCalls > node.maxToolTurns) throw new Error(`NATIVE_HARNESS_TOOL_LIMIT:${node.maxToolTurns}`);
          const kind = claudeCodeToolClass(use.name);
          for (const target of claudeCodeToolPaths(use.input)) {
            const relativePath = inside(roots, target);
            if (relativePath === null) throw new Error(`NATIVE_HARNESS_TOOL_PATH_OUTSIDE_WORKTREE:${use.name}`);
            if (kind === "write" && !writable.has(relativePath)) throw new Error(`NATIVE_HARNESS_WRITE_OUTSIDE_LEASE:${relativePath}`);
          }
        }
      } else if (event.kind === "tool_results") {
        for (const result of event.results) push({ type: "tool_result", nodeId: node.id, turn: state.turn, callId: result.toolUseId,
          result: { ok: !result.isError, summary: result.isError ? "Native tool error" : "Native tool result", content: policy.toolContext.protect(result.content, { sourceId: `${node.id}:${result.toolUseId}` }),
            artifact: null, truncated: false, trust: "untrusted", ...(result.isError ? { error: { code: "NATIVE_TOOL_ERROR", message: "Native tool reported an error" } } : {}) } });
      } else if (event.kind === "result") state.result = event;
    };
    const processes = this.invocation.processes ?? { run: runNativeProcess };
    // A consumer that stops iterating early must not leave the process running.
    const controller = new AbortController();
    const forward = () => controller.abort(policy.signal.reason);
    policy.signal.addEventListener("abort", forward, { once: true });
    if (policy.signal.aborted) forward();
    const execution = processes.run({ executable: this.invocation.executable, arguments: argv, cwd: this.invocation.cwd, environment: this.invocation.environment,
      stdin: prompt.text, timeoutMs: this.invocation.timeoutMs, maximumOutputBytes: this.invocation.maximumOutputBytes, signal: controller.signal, onLine,
      ...(this.invocation.onSpawn === undefined ? {} : { onSpawn: this.invocation.onSpawn }) })
      .finally(() => { finished = true; notify?.(); });
    let outcome: NativeProcessResult;
    try {
      while (true) {
        while (queue.length > 0) { const next = queue.shift(); if (next !== undefined) yield next; }
        if (finished) break;
        await new Promise<void>((wake) => { notify = wake; if (queue.length > 0 || finished) wake(); });
        notify = null;
      }
      outcome = await execution;
    } finally {
      policy.signal.removeEventListener("abort", forward);
      if (!finished) { controller.abort(); await execution.catch(() => undefined); }
    }
    while (queue.length > 0) { const next = queue.shift(); if (next !== undefined) yield next; }
    const observedProcess = { pid: outcome.pid, exitCode: outcome.exitCode, exitSignal: outcome.exitSignal, stopped: outcome.stopped, violation: outcome.violation, stderr: outcome.stderr, treeTerminated: outcome.treeTerminated };
    const usage = state.result?.usage ?? null;
    const fail = (code: string): never => { throw new NativeHarnessError(code, { usage, process: observedProcess }); };
    if (!outcome.treeTerminated) fail("NATIVE_HARNESS_CLEANUP_FAILED");
    if (outcome.stopped === "cancelled") fail("NATIVE_HARNESS_CANCELLED");
    if (outcome.stopped === "timeout") fail("NATIVE_HARNESS_TIMEOUT");
    if (outcome.stopped === "output_limit") fail("NATIVE_HARNESS_OUTPUT_LIMIT");
    if (outcome.stopped === "spawn_error") fail("NATIVE_HARNESS_SPAWN_FAILED");
    if (outcome.stopped === "violation") {
      const violation = outcome.violation;
      fail(violation instanceof NativeEventError || violation instanceof Error ? violation.message : "NATIVE_HARNESS_PROTOCOL_VIOLATION");
    }
    if (state.result === null) fail(`NATIVE_HARNESS_CRASHED:${outcome.exitSignal ?? String(outcome.exitCode)}`);
    const result = state.result as Extract<ClaudeCodeEvent, { kind: "result" }>;
    if (result.subtype === "error_max_turns") fail(`NATIVE_HARNESS_TURN_LIMIT:${this.invocation.maximumTurns}`);
    if (result.isError) fail(`NATIVE_HARNESS_EXECUTION_ERROR:${result.subtype}`);
    if (outcome.exitCode !== 0) fail(`NATIVE_HARNESS_CRASHED:${outcome.exitSignal ?? String(outcome.exitCode)}`);
    yield Object.freeze({ type: "completed", nodeId: node.id, turns: result.turns ?? state.messages.size, text: result.text, refusal: null, usage, costUsd: result.costUsd });
  }
}

/** Relative POSIX path of `target` inside one of `roots`, or null when it escapes. */
function inside(roots: readonly string[], target: string): string | null {
  for (const root of roots) {
    const absolute = resolve(root, target);
    const path = relative(root, absolute);
    if (path === "") return ".";
    if (!path.startsWith("..") && !isAbsolute(path)) return path.split(sep).join("/");
  }
  return null;
}
