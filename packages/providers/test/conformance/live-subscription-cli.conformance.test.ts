import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/registry.js";
import { TransportError, type TransportRequest, type TransportResponse } from "../../src/transport-contract.js";
import { probeCliReadiness } from "../../src/transports/cli/probe.js";
import { CLI_TRANSPORT_SUPPORT } from "../../src/transports/cli/support.js";

/**
 * Live subscription CLI conformance: a handful of tiny calls per signed-in CLI, through the
 * production registry and transport, with redacted evidence. Opt-in only; it spends a small
 * amount of the operator's subscription allowance:
 *
 *   ARBITRA_LIVE_SUBSCRIPTION_CLI=claude-code:claude-haiku-4-5-20251001,codex:gpt-5.4-mini \
 *   ARBITRA_LIVE_EVIDENCE_DIR=docs/qa/subscription-cli \
 *     pnpm --filter @arbitra/providers exec vitest run test/conformance/live-subscription-cli.conformance.test.ts
 *
 * Executables are discovered as in production (override variable, PATH, install locations).
 * A CLI that is not installed, not signed in or refused is recorded with its error class and
 * never counted as passing.
 */
const selected = (process.env["ARBITRA_LIVE_SUBSCRIPTION_CLI"] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
  .map((entry) => { const [vendor, ...model] = entry.split(":"); return { vendor: vendor ?? "", modelId: model.join(":") }; });
const evidenceDirectory = resolve(process.env["ARBITRA_LIVE_EVIDENCE_DIR"] ?? ".runs/live/subscription-cli");
const redact = (text: string) => text.replace(/(sk-(?:ant-[a-z0-9]+-|proj-)?|AIza|ya29\.)[A-Za-z0-9_.-]{6,}/gu, "$1<redacted>").replace(/[\w.+-]+@[\w-]+\.[\w.]+/gu, "<email>").slice(0, 400);

interface Observation { readonly case: string; readonly status: "passed" | "failed" | "unavailable"; readonly detail: string; readonly durationMs: number;
  readonly usage: TransportResponse["usage"] | null; readonly providerRequestId: string | null; readonly transportVersion: string | null; readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: unknown }[] }

describe.skipIf(selected.length === 0)("live subscription CLI conformance", () => {
  it.each(selected)("$vendor answers text and emulated tool calls through the production transport", async ({ vendor, modelId }) => {
    const support = CLI_TRANSPORT_SUPPORT.find((entry) => entry.vendor === vendor);
    if (support === undefined || modelId === "") throw new Error(`usage: ARBITRA_LIVE_SUBSCRIPTION_CLI=<vendor>:<model>; unknown ${vendor}`);
    const readiness = await probeCliReadiness(support.transport, { lookup: (name) => process.env[name], auth: "subscription_login", oauthTokenEnv: null, limits: null });
    const transport = new ProviderRegistry([{ id: vendor, providerId: vendor, transport: support.transport, endpoint: support.endpoint, auth: "subscription_login" }], { cli: { limits: null } }).transports[vendor];
    if (transport === undefined) throw new Error("TRANSPORT_ABSENT");
    const observations: Observation[] = [];
    const observe = async (name: string, request: TransportRequest, check: (response: TransportResponse) => string | null) => {
      const started = Date.now();
      try {
        const response = await transport.send(request, AbortSignal.timeout(180_000));
        const problem = check(response);
        observations.push({ case: name, status: problem === null ? "passed" : "failed", detail: redact(problem ?? response.text ?? JSON.stringify(response.toolCalls)), durationMs: Date.now() - started,
          usage: response.usage, providerRequestId: response.providerRequestId, transportVersion: response.transportVersion ?? null, toolCalls: response.toolCalls });
        return response;
      } catch (error) {
        const code = error instanceof TransportError ? error.code : "UNKNOWN";
        observations.push({ case: name, status: code === "AUTH" || code === "QUOTA" || code === "RATE_LIMIT" ? "unavailable" : "failed", detail: redact(`${code}: ${error instanceof Error ? error.message : String(error)}`),
          durationMs: Date.now() - started, usage: null, providerRequestId: null, transportVersion: null });
        return null;
      }
    };
    const tools = [{ name: "lookup_word", description: "Returns the definition of a word.", inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false } }];
    const system = { role: "system" as const, content: "Follow the user's instruction exactly." };
    const text = await observe("text", { modelId, maximumOutputTokens: 400, messages: [system, { role: "user", content: "Reply with exactly: pong" }] },
      (response) => /pong/iu.test(response.text ?? "") && response.usage.outputTokens !== null ? null : "reply did not contain pong or usage was missing");
    let turn = null as TransportResponse | null;
    if (text !== null) {
      const ask = { role: "user" as const, content: "Use the lookup_word tool to look up the word \"arbitra\", then reply with JSON {\"definition\": <the tool's answer>}." };
      turn = await observe("tool_call", { modelId, maximumOutputTokens: 600, messages: [system, ask], tools },
        (response) => response.toolCalls.length === 1 && response.toolCalls[0]?.name === "lookup_word" ? null : "no single lookup_word call");
      if (turn !== null && turn.toolCalls.length === 1) {
        const call = turn.toolCalls[0];
        if (call === undefined) throw new Error("TOOL_CALL_ABSENT");
        await observe("tool_result", { modelId, maximumOutputTokens: 600, tools, messages: [system, ask, { role: "assistant", content: "", toolCalls: turn.toolCalls },
          { role: "tool", content: JSON.stringify({ definition: "an arbiter of models" }), toolCallId: call.id, toolName: call.name }] },
        (response) => response.toolCalls.length === 0 && /arbiter of models/iu.test(response.text ?? "") ? null : "final answer did not use the tool result");
      }
    }
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(resolve(evidenceDirectory, `${vendor}.json`), `${JSON.stringify({ recordedAt: new Date().toISOString(), host: `${process.platform}-${process.arch}`, node: process.version,
      transport: support.transport, modelId, executableSource: readiness.executable.found ? readiness.executable.executable.source : null, cliVersion: readiness.version,
      versionSupported: readiness.versionSupported, auth: readiness.auth, observations }, null, 2)}\n`);
    for (const observation of observations) expect(observation.status, `${observation.case}: ${observation.detail}`).not.toBe("failed");
  }, 600_000);
});
