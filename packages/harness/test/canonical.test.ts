import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessEvent, HarnessModelRequest, HarnessProviderRuntime } from "../src/adapter.js";
import { CanonicalHarnessAdapter } from "../src/canonical/adapter.js";
import { assertHarnessCompatible, CANONICAL_HARNESS_PROFILE, canonicalCompatibility, ROUND_ZERO_POLICY, type HarnessProfile } from "../src/profile.js";

const usage = Object.freeze({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, cacheWriteTokens: 0 });

describe("canonical harness", () => {
  it("runs every bounded model turn through the provider runtime and emits tool events", async () => {
    const requests: HarnessModelRequest[] = []; const traces: Array<{ outcome: string; continuation: null }> = [];
    const runtime: HarnessProviderRuntime = { async invoke(request) {
      requests.push(request); traces.push({ outcome: "success", continuation: null });
      return requests.length === 1
        ? { text: "reading", toolCalls: [{ id: "call-1", name: "repo.readFile", arguments: { path: "src/a.ts" } }], refusal: null, usage }
        : { text: "done", toolCalls: [], refusal: null, usage };
    } };
    const tools = { async invoke(_name: string, _args: unknown, context: { protect: (content: string, meta: { sourceId: string }) => string }) { return { ok: true, summary: "source", content: context.protect("source", { sourceId: "fixture" }), artifact: null, truncated: false, trust: "untrusted" as const }; } };
    const events = await collect(new CanonicalHarnessAdapter(runtime).run(
      { id: "round-0", modelId: "fake", maximumOutputTokens: 100, maxToolTurns: 1 },
      { text: "compiled prompt", hash: "p".repeat(64) },
      [{ name: "repo.readFile", description: "read", inputSchema: {} }], tools,
      { mode: "audit", round: 0, requirements: { structuredEvents: true, enforcesExternalPolicy: true, reportsUsage: true }, signal: new AbortController().signal, toolContext: { protect: (content) => `<repository_content trust="untrusted">${content}</repository_content>` } },
    ).events);
    expect(requests).toHaveLength(2); expect(traces).toEqual([{ outcome: "success", continuation: null }, { outcome: "success", continuation: null }]);
    expect(events.map(({ type }) => type)).toEqual(["model_turn_started", "model_turn_completed", "tool_call", "tool_result", "model_turn_started", "model_turn_completed", "completed"]);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
  });

  it("enforces the model-profile tool-loop bound", async () => {
    const runtime: HarnessProviderRuntime = { async invoke() { return { text: null, toolCalls: [{ id: "again", name: "repo.readFile", arguments: {} }], refusal: null, usage }; } };
    const run = new CanonicalHarnessAdapter(runtime).run({ id: "n", modelId: "m", maximumOutputTokens: 10, maxToolTurns: 0 }, { text: "p", hash: "h" }, [], { async invoke() { throw new Error("not reached"); } }, { mode: "feature", round: 1, requirements: {}, signal: new AbortController().signal, toolContext: { protect: (content) => content } });
    await expect(collect(run.events)).rejects.toThrow("HARNESS_TOOL_LOOP_LIMIT:0");
  });

  it("refuses missing hard capabilities and internal context management in audit mode", () => {
    const profile = (changes: Partial<HarnessProfile["capabilities"]>): HarnessProfile => ({ ...CANONICAL_HARNESS_PROFILE, capabilities: { ...CANONICAL_HARNESS_PROFILE.capabilities, ...changes } });
    expect(() => assertHarnessCompatible(profile({ structuredEvents: false }), "feature", { structuredEvents: true })).toThrow("HARNESS_CAPABILITY_REQUIRED:structuredEvents");
    expect(() => assertHarnessCompatible(profile({ enforcesExternalPolicy: false }), "feature", { enforcesExternalPolicy: true })).toThrow("HARNESS_CAPABILITY_REQUIRED:enforcesExternalPolicy");
    expect(() => assertHarnessCompatible(profile({ reportsUsage: false }), "feature", { reportsUsage: true })).toThrow("HARNESS_CAPABILITY_REQUIRED:reportsUsage");
    expect(() => assertHarnessCompatible(profile({ managesContextInternally: true }), "audit")).toThrow("AUDIT_INTERNAL_CONTEXT_FORBIDDEN");
  });

  it("asserts every round-zero independence policy value", () => {
    expect(ROUND_ZERO_POLICY).toEqual({ projectInstructions: "disabled", network: "none", memory: "none", subagents: false, advisor: false });
    expect(CANONICAL_HARNESS_PROFILE.capabilities).toMatchObject({ writeFiles: false, skills: false, subagents: false });
    expect(canonicalCompatibility("fake-model", "1")).toEqual({ harnessId: "arbitra-canonical", harnessVersion: "1.0.0", modelProfileId: "fake-model", modelProfileVersion: "1", tested: true });
  });

  it("contains no native adapter or concrete transport import", async () => {
    const roots = [resolve(process.cwd(), "src"), resolve(process.cwd(), "..", "workflow", "src")];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const contents = await Promise.all(files.map(async (path) => [path, await readFile(path, "utf8")] as const));
    expect(contents.filter(([, text]) => /providers\/src\/(?:transports|transport-contract)|NativeHarnessAdapter/u.test(text))).toEqual([]);
  });
});

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> { const result: HarnessEvent[] = []; for await (const event of events) result.push(event); return result; }
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? sourceFiles(resolve(directory, entry.name)) : Promise.resolve(entry.name.endsWith(".ts") ? [resolve(directory, entry.name)] : [])))).flat();
}
