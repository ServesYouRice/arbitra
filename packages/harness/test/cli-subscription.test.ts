import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "@arbitra/providers/registry.js";
import { writeCliStandIn } from "@arbitra/providers/transports/cli/stand-in.js";
import { requireCliTransportSupport, type CliVendor } from "@arbitra/providers/transports/cli/support.js";
import type { HarnessEvent, HarnessProviderRuntime } from "../src/adapter.js";
import { CanonicalHarnessAdapter } from "../src/canonical/adapter.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/**
 * The canonical harness drives a subscription CLI exactly as it drives an API transport:
 * emulated tool calls come back as ordinary tool calls, arbitra runs the tool, and the
 * result reaches the next CLI call in the framed transcript under the same call ID.
 */
describe.each(["claude-code", "codex", "gemini"] as const)("canonical harness over the %s subscription CLI", { timeout: 30_000 }, (vendor: CliVendor) => {
  it("round-trips an emulated tool call through arbitra's tool loop", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "arbitra-harness-cli-"))); roots.push(root);
    await mkdir(join(root, "tmp"));
    const support = requireCliTransportSupport(vendor);
    const executable = await writeCliStandIn(root, { vendor, reportFile: join(root, "report"), replies: [
      { kind: "text", text: "{\"toolCalls\":[{\"name\":\"repo.readFile\",\"arguments\":{\"path\":\"src/a.ts\"}}]}" },
      { kind: "text", text: "{\"findings\":[]}" },
    ] });
    const env: Record<string, string> = { HOME: join(root, "home"), PATH: "/usr/bin:/bin", [support.executableEnvVar]: executable };
    const transport = new ProviderRegistry([{ id: "sub", providerId: vendor, transport: support.transport, endpoint: support.endpoint, auth: "subscription_login" }],
      { cli: { lookup: (name) => env[name], temporaryDirectory: join(root, "tmp"), limits: null } }).transports["sub"];
    if (transport === undefined) throw new Error("TRANSPORT_ABSENT");
    const runtime: HarnessProviderRuntime = { async invoke(request, context) {
      const response = await transport.send({ modelId: request.modelId, messages: request.messages, tools: request.tools, maximumOutputTokens: request.maximumOutputTokens }, context.signal);
      return { text: response.text, toolCalls: response.toolCalls, refusal: response.refusal, usage: response.usage };
    } };
    const invoked: { name: string; args: unknown; callId: string | undefined }[] = [];
    const tools = { async invoke(name: string, args: unknown, context: { callId?: string }) { invoked.push({ name, args, callId: context.callId }); return { ok: true, summary: "read", content: "export const a = 1;", artifact: null, truncated: false, trust: "untrusted" as const }; } };
    const events: HarnessEvent[] = [];
    for await (const event of new CanonicalHarnessAdapter(runtime).run({ id: "discovery", modelId: "model-x", maximumOutputTokens: 1000, maxToolTurns: 2 }, { text: "Audit the source.", hash: "h".repeat(64) },
      [{ name: "repo.readFile", description: "Read a repository file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }], tools,
      { mode: "audit", round: 0, requirements: { structuredEvents: true, enforcesExternalPolicy: true, reportsUsage: true }, signal: new AbortController().signal, toolContext: { protect: (content) => content } }).events) events.push(event);
    expect(events.map(({ type }) => type)).toEqual(["model_turn_started", "model_turn_completed", "tool_call", "tool_result", "model_turn_started", "model_turn_completed", "completed"]);
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "{\"findings\":[]}", turns: 2 });
    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({ name: "repo.readFile", args: { path: "src/a.ts" } });
    const callId = invoked[0]?.callId ?? "";
    expect(callId).toMatch(/^call_[a-f0-9]{24}$/u);
    const second = JSON.parse(await readFile(`${join(root, "report")}.1`, "utf8")) as { stdin: string };
    expect(second.stdin).toContain(`<<<BEGIN tool-result id=${callId} name=repo.readFile`);
    expect(second.stdin).toContain("export const a = 1;");
    expect(second.stdin).toContain(`"toolCalls":[{"id":"${callId}","name":"repo.readFile"`);
  });
});
