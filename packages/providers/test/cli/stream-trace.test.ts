import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeProcessPort, NativeProcessResult } from "../../src/process.js";
import { ProviderRegistry } from "../../src/registry.js";
import { streamSummary, TransportError, type ProviderTransport } from "../../src/transport-contract.js";
import { eventType, redactedTail, StreamRecorder } from "../../src/transports/cli/stream-trace.js";
import { requireCliTransportSupport } from "../../src/transports/cli/support.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Claude Code over a process port that streams `lines` a minute apart, writes `stderr`, and stops as `stopped` says. */
async function claude(lines: readonly unknown[], stderr: string, stopped: NativeProcessResult["stopped"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "arbitra-cli-trace-"))); roots.push(root);
  const home = join(root, "home"); const temporary = join(root, "tmp"); const executable = join(root, "claude");
  await Promise.all([home, temporary].map((directory) => mkdir(directory)));
  await writeFile(executable, "", { mode: 0o755 });
  let now = Date.parse("2026-10-26T14:18:00Z");
  const port: NativeProcessPort = { async run(input): Promise<NativeProcessResult> {
    const result = { pid: null, exitCode: 0, exitSignal: null, stopped: null, violation: null, stdout: "", stderr: "", treeTerminated: true };
    if (input.arguments.includes("--version")) return { ...result, stdout: "2.1.296 (Claude Code)\n" };
    for (const line of lines) { now += 60_000; input.onLine?.(JSON.stringify(line)); }
    input.onStderr?.(stderr);
    now += 15 * 60_000;
    return { ...result, exitCode: null, stopped, stderr };
  } };
  const support = requireCliTransportSupport("claude-code-cli");
  const env: Record<string, string> = { HOME: home, USERPROFILE: home, [support.executableEnvVar]: executable };
  const registry = new ProviderRegistry([{ id: "sub", providerId: "anthropic", transport: support.transport, endpoint: support.endpoint, auth: "subscription_login" }],
    { cli: { lookup: (name) => env[name], process: port, temporaryDirectory: temporary, limits: null, now: () => now } });
  return registry.transports["sub"] as ProviderTransport;
}
async function failure(promise: Promise<unknown>): Promise<TransportError> {
  try { await promise; } catch (error) { if (error instanceof TransportError) return error; throw error; }
  throw new Error("expected a TransportError");
}
const request = { modelId: "model-x", maximumOutputTokens: 1000, messages: [{ role: "user" as const, content: "Say pong." }] };

describe("the trace a failed CLI call keeps", () => {
  it("tells a call that received nothing from one that was streaming when its time ran out", async () => {
    // Observed (October 26, 2026, macOS): a timed-out call kept no last event and no stderr, so only pmset -g log showed the Mac had slept.
    const silent = await failure((await claude([], "", "timeout")).send(request, new AbortController().signal));
    expect(silent).toMatchObject({ code: "TIMEOUT", stream: { events: 0, lastEventAt: null, lastEventType: null, startedAt: "2026-10-26T14:18:00.000Z", stoppedAt: "2026-10-26T14:33:00.000Z" } });
    expect(silent.message).toContain("; stream: no event in the 15.0 min it ran");
    const streaming = await failure((await claude([{ type: "system", subtype: "init", session_id: "s" }, { type: "stream_event", event: { type: "content_block_delta" } }],
      "Retrying after a network error, token=abc123secret, for someone@example.com\n", "timeout")).send(request, new AbortController().signal));
    expect(streaming.stream).toMatchObject({ events: 2, lastEventAt: "2026-10-26T14:20:00.000Z", lastEventType: "stream_event/content_block_delta" });
    expect(streaming.stream?.stderrTail).toBe("Retrying after a network error, token=<redacted> for <email>\n");
    expect(streaming.message).toContain("; stream: 2 events in 17.0 min, the last (stream_event/content_block_delta) 15.0 min before it stopped; stderr: Retrying after a network error, token=<redacted> for <email>");
  });

  it("keeps the trace on a call its stage timeout cancelled, for the runtime's timeout to report, without changing its message", async () => {
    const cancelled = await failure((await claude([{ type: "assistant" }], "", "cancelled")).send(request, new AbortController().signal));
    expect(cancelled).toMatchObject({ code: "CANCELLED", message: "Provider request cancelled", stream: { events: 1, lastEventType: "assistant" } });
  });

  it("reads an event's type and the end of stderr without its secrets", () => {
    expect(eventType(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } }))).toBe("item.completed/agent_message");
    expect(eventType("not json")).toBeNull();
    expect(redactedTail(`${"x".repeat(3_000)} Authorization: Bearer abcdefghijklmnop sk-ant-api03-abcdefghij`, 60)).toMatch(/Bearer <redacted> sk-ant-api03-<redacted>$/u);
    let now = 0; const recorder = new StreamRecorder(() => now);
    now = 90_000; expect(streamSummary(recorder.trace())).toBe("stream: no event in the 1.5 min it ran");
  });
});
