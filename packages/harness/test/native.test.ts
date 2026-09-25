import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent, HarnessRunPolicy } from "../src/adapter.js";
import { assertCanonicalMeasurements, harnessMeasurementClass } from "../src/measurement.js";
import { ClaudeCodeHarnessAdapter, NativeHarnessError, type NativeInvocation } from "../src/native/claude-code/adapter.js";
import { claudeCodeArguments, claudeCodeEnvironment, isClaudeCodeControlPath, parseClaudeCodeEvent, parseClaudeCodeVersion } from "../src/native/claude-code/translation.js";
import { runNativeProcess } from "../src/native/process.js";
import { processTerminated, writeStandInExecutable, type StandInScenario } from "../src/native/stand-in.js";
import { assertNativeHarnessSupported, NATIVE_HARNESS_SUPPORT, nativeHarnessSupport, unenforceableNativeTools } from "../src/native/support.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "native-harness-")); roots.push(root); return root; }

const policy = (signal = new AbortController().signal): HarnessRunPolicy => ({ mode: "testing", round: 1, requirements: { structuredEvents: true }, signal, toolContext: { protect: (content) => `<untrusted>${content}</untrusted>` } });
const tools = ["Read", "Glob", "Grep", "Edit", "Write"].map((name) => ({ name, description: name, inputSchema: {} }));
const unused = { async invoke(): Promise<never> { throw new Error("UNUSED"); } };

async function run(scenario: StandInScenario, overrides: Partial<NativeInvocation> = {}, signal?: AbortSignal) {
  const root = await directory();
  const executable = await writeStandInExecutable(root, scenario);
  const cwd = await mkdtemp(join(root, "work-"));
  const adapter = new ClaudeCodeHarnessAdapter({ executable, cwd, environment: { PATH: process.env["PATH"] ?? "" }, model: "fixture-model", maximumTurns: 10, timeoutMs: 20_000,
    maximumOutputBytes: 1_000_000, maximumTokens: 100_000, writablePaths: ["tests/a.test.ts"], ...overrides });
  const events: HarnessEvent[] = [];
  let failure: NativeHarnessError | null = null;
  try {
    for await (const event of adapter.run({ id: "testing/native-writer/x", modelId: "fixture-model", maximumOutputTokens: 100, maxToolTurns: 4 }, { text: "prompt", hash: "h" }, tools, unused, policy(signal)).events) events.push(event);
  } catch (error) { if (!(error instanceof NativeHarnessError)) throw error; failure = error; }
  return { events, failure, cwd, root };
}

describe("native harness support matrix", () => {
  it("declares Claude Code for the Testing writer only, unverified until real conformance runs", () => {
    expect(NATIVE_HARNESS_SUPPORT.map(({ harnessId, stages, status, versionRange }) => ({ harnessId, stages, status, versionRange }))).toEqual([
      { harnessId: "claude-code", stages: ["testing-writer"], status: "declared_unverified", versionRange: { minimum: "2.0.0", below: "3.0.0" } },
    ]);
    expect(assertNativeHarnessSupported("claude-code", "2.1.0", "testing-writer").profile.id).toBe("native:claude-code");
    expect(() => assertNativeHarnessSupported("claude-code", "1.9.9", "testing-writer")).toThrow("NATIVE_HARNESS_VERSION_UNSUPPORTED:claude-code@1.9.9");
    expect(() => assertNativeHarnessSupported("claude-code", "3.0.0", "testing-writer")).toThrow("NATIVE_HARNESS_VERSION_UNSUPPORTED");
    expect(() => assertNativeHarnessSupported("claude-code", "2.1.0", "discovery")).toThrow("NATIVE_HARNESS_STAGE_UNSUPPORTED");
    expect(() => nativeHarnessSupport("codex")).toThrow("NATIVE_HARNESS_UNSUPPORTED:codex");
    expect(unenforceableNativeTools(nativeHarnessSupport("claude-code"), ["Read", "Bash", "WebFetch", "Task", "mcp__x__y", "Mystery"]).map(({ tool, reason }) => [tool, reason]))
      .toEqual([["Bash", "shell"], ["WebFetch", "network"], ["Task", "subagent"], ["mcp__x__y", "mcp"], ["Mystery", "unknown"]]);
  });

  it("refuses the native profile for Audit and round-zero discovery at the port", () => {
    const adapter = new ClaudeCodeHarnessAdapter({ executable: "/bin/false", cwd: "/tmp", environment: {}, model: null, maximumTurns: 1, timeoutMs: 1000, maximumOutputBytes: 1000, maximumTokens: 1, writablePaths: [] });
    const node = { id: "n", modelId: "m", maximumOutputTokens: 1, maxToolTurns: 1 };
    expect(() => adapter.run(node, { text: "", hash: "" }, [], unused, { ...policy(), mode: "audit" })).toThrow("AUDIT_INTERNAL_CONTEXT_FORBIDDEN");
    expect(() => adapter.run(node, { text: "", hash: "" }, [], unused, { ...policy(), round: 0 })).toThrow("ROUND_ZERO_POLICY_VIOLATION");
    expect(() => adapter.run(node, { text: "", hash: "" }, [{ name: "Bash", description: "", inputSchema: {} }], unused, policy())).toThrow("NATIVE_HARNESS_TOOL_UNENFORCEABLE:Bash");
  });

  it("classifies native identities so they are never pooled with canonical measurements", () => {
    expect(harnessMeasurementClass("arbitra-canonical")).toBe("canonical");
    expect(harnessMeasurementClass("native:claude-code")).toBe("native");
    expect(() => assertCanonicalMeasurements(["arbitra-canonical", "direct-json"], "premise")).not.toThrow();
    expect(() => assertCanonicalMeasurements(["arbitra-canonical", "native:claude-code"], "premise")).toThrow("NATIVE_MEASUREMENT_NOT_POOLABLE:premise:native:claude-code");
  });
});

describe("Claude Code translation layer", () => {
  it("builds lease-scoped argv and a sanitized environment", () => {
    const argv = claudeCodeArguments({ model: "m", maximumTurns: 3, tools: ["Read", "Write"], writablePaths: ["tests/a.test.ts"] });
    expect(argv).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "3", "--model", "m", "--allowedTools", "Read,Write(./tests/a.test.ts)",
      "--disallowedTools", "Bash,BashOutput,KillShell,WebFetch,WebSearch,Task,NotebookEdit", "--strict-mcp-config"]);
    expect(() => claudeCodeArguments({ model: null, maximumTurns: 1, tools: ["Bash"], writablePaths: [] })).toThrow("NATIVE_HARNESS_TOOL_UNENFORCEABLE:Bash");
    const environment = claudeCodeEnvironment({ host: { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "y", HOME: "/Users/me" }, home: "/s/home", configDirectory: "/s/config", temporaryDirectory: "/s/tmp", credentialTarget: "ANTHROPIC_API_KEY", credential: "k" });
    expect(Object.keys(environment).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "DISABLE_TELEMETRY", "HOME", "NO_COLOR", "PATH", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]);
    expect(environment["HOME"]).toBe("/s/home");
    expect(["CLAUDE.md", "a/CLAUDE.local.md", ".claude/settings.json", ".mcp.json"].every(isClaudeCodeControlPath)).toBe(true);
    expect(isClaudeCodeControlPath("tests/claude.test.ts")).toBe(false);
  });

  it("parses versions and events, rejecting malformed shapes and tolerating unknown types", () => {
    expect(parseClaudeCodeVersion("2.0.14 (Claude Code)\n")).toBe("2.0.14");
    expect(parseClaudeCodeVersion("claude version unknown")).toBeNull();
    expect(parseClaudeCodeEvent('{"type":"stream_event","event":{}}')).toEqual({ kind: "ignored", type: "stream_event" });
    expect(() => parseClaudeCodeEvent("{not json")).toThrow("NATIVE_HARNESS_MALFORMED_EVENT:invalid_json");
    expect(() => parseClaudeCodeEvent('{"type":"assistant","message":{"content":"text"}}')).toThrow("NATIVE_HARNESS_MALFORMED_EVENT:assistant_content");
    expect(parseClaudeCodeEvent('{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":3}}'))
      .toMatchObject({ kind: "result", usage: { inputTokens: 15, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: null } });
    expect(parseClaudeCodeEvent('{"type":"result","subtype":"success","result":"ok"}')).toMatchObject({ kind: "result", usage: null });
  });
});

describe("Claude Code adapter against a scripted native process", () => {
  it("translates a successful run into shared harness events with measured usage", async () => {
    const { events, failure, cwd } = await run({ steps: [{ tool: "Read", input: { file_path: "src/a.ts" } }, { write: "tests/a.test.ts", content: "test();\n" }] });
    expect(failure).toBeNull();
    expect(events.map(({ type }) => type)).toEqual(["harness_started", "model_turn_started", "model_turn_completed", "tool_call", "tool_result", "model_turn_started", "model_turn_completed", "tool_call", "tool_result", "completed"]);
    expect(events.at(-1)).toMatchObject({ type: "completed", usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 0 }, costUsd: 0.01 });
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ result: { trust: "untrusted", content: "<untrusted>ok</untrusted>" } });
    expect(await readFile(join(cwd, "tests/a.test.ts"), "utf8")).toBe("test();\n");
  });

  it("reports unknown usage as null, never zero", async () => {
    const { events, failure } = await run({ omitMessageUsage: true, steps: [{ text: "done" }], result: { type: "result", subtype: "success", is_error: false, result: "{}" } });
    expect(failure).toBeNull();
    expect(events.some(({ type }) => type === "model_turn_completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "completed", usage: null, costUsd: null });
  });

  it.each([
    ["malformed event", { steps: [{ raw: "{\"type\":\"assistant\",\"message\":7}" }] }, "NATIVE_HARNESS_MALFORMED_EVENT:assistant_message"],
    ["invalid JSON", { steps: [{ raw: "not json at all" }] }, "NATIVE_HARNESS_MALFORMED_EVENT:invalid_json"],
    ["crash mid-stream", { steps: [{ text: "working" }, { exit: 3 }] }, "NATIVE_HARNESS_CRASHED:3"],
    ["result then non-zero exit", { steps: [], exitCode: 2 }, "NATIVE_HARNESS_CRASHED:2"],
    ["error result", { steps: [], result: { type: "result", subtype: "error_during_execution", is_error: true } }, "NATIVE_HARNESS_EXECUTION_ERROR:error_during_execution"],
    ["max turns", { steps: [], result: { type: "result", subtype: "error_max_turns", is_error: true } }, "NATIVE_HARNESS_TURN_LIMIT:10"],
    ["forbidden shell tool", { steps: [{ tool: "Bash", input: { command: "curl example.com" } }] }, "NATIVE_HARNESS_TOOL_NOT_PERMITTED:Bash"],
    ["tool-call limit", { steps: Array.from({ length: 5 }, () => ({ tool: "Read", input: { file_path: "a" } })) }, "NATIVE_HARNESS_TOOL_LIMIT:4"],
    ["read outside the scratch copy", { steps: [{ tool: "Read", input: { file_path: "/etc/hosts" } }] }, "NATIVE_HARNESS_TOOL_PATH_OUTSIDE_WORKTREE:Read"],
    ["write outside the lease", { steps: [{ write: "src/app.ts", content: "x" }] }, "NATIVE_HARNESS_WRITE_OUTSIDE_LEASE:src/app.ts"],
    ["active MCP server", { mcpServers: [{ name: "remote", status: "connected" }], steps: [] }, "NATIVE_HARNESS_MCP_ACTIVE"],
    ["no result event", { steps: [{ text: "bye" }], result: null }, "NATIVE_HARNESS_CRASHED:0"],
  ] as const)("fails closed on %s", async (_name, scenario, code) => {
    const { failure } = await run(scenario as StandInScenario);
    expect(failure?.code).toBe(code);
    expect(failure?.observed.process?.treeTerminated).toBe(true);
  });

  it("stops at the streamed token ceiling", async () => {
    const { failure } = await run({ steps: [{ text: "a" }, { text: "b" }] }, { maximumTokens: 20 });
    expect(failure?.code).toBe("NATIVE_HARNESS_TOKEN_LIMIT:20");
  });

  it("kills the whole process tree on timeout", async () => {
    const root = await directory(); const pidFile = join(root, "child.pid");
    const { failure } = await run({ pidFile, steps: [{ text: "thinking" }, { hang: true }] }, { timeoutMs: 1_500 });
    expect(failure?.code).toBe("NATIVE_HARNESS_TIMEOUT");
    expect(failure?.observed.process?.treeTerminated).toBe(true);
    const child = Number(await readFile(pidFile, "utf8"));
    expect(await processTerminated(child)).toBe(true);
  });

  it("kills the whole process tree on cancellation", async () => {
    const root = await directory(); const pidFile = join(root, "child.pid");
    const controller = new AbortController();
    const pending = run({ pidFile, steps: [{ hang: true }] }, {}, controller.signal);
    await waitFor(async () => { try { await readFile(pidFile, "utf8"); return true; } catch { return false; } });
    controller.abort();
    const { failure } = await pending;
    expect(failure?.code).toBe("NATIVE_HARNESS_CANCELLED");
    expect(await processTerminated(Number(await readFile(pidFile, "utf8")))).toBe(true);
  });

  it("reports a missing executable as a spawn failure", async () => {
    const result = await runNativeProcess({ executable: "/nonexistent/claude", arguments: [], cwd: tmpdir(), environment: {}, stdin: "", timeoutMs: 5_000, maximumOutputBytes: 100, signal: new AbortController().signal });
    expect(result.stopped).toBe("spawn_error");
  });
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (await check()) return; await new Promise((wake) => setTimeout(wake, 25)); }
  throw new Error("WAIT_TIMEOUT");
}
