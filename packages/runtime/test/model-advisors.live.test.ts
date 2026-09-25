import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProviderEndpoint } from "@arbitra/providers/registry.js";
import { FetchHttpClient, type HttpRequest } from "@arbitra/providers/transport-contract.js";
import { advisorPolicySchema } from "@arbitra/schemas/advisor.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { ADVISOR_HARNESS_ID, ModelActivities } from "../src/model-activities.js";
import { TaskAdvisor, validateAdvisorPolicy, type AdvisorContext, type AdvisorExecutor, type AdvisorOutcome } from "../src/model-advisors.js";
import { RunStore } from "../src/run-store.js";

/**
 * P13 live advisor path: a bounded task advisor consulted through the production
 * TaskAdvisor -> ModelActivities -> provider pool -> transport stack against a real
 * endpoint. It verifies the use limit (a replay is not re-paid, an extra use is refused
 * without a provider call), the recorded advisor identity, and measured usage charged to
 * the advisor ledger and the run budget. Opt-in only:
 *
 *   ARBITRA_LIVE_ADVISOR=1 ARBITRA_LIVE_ENDPOINTS=tooling/live/endpoints.json \
 *   ARBITRA_LIVE_ADVISOR_ENDPOINTS=gemini-native,gemini-compatible-chat \
 *   ARBITRA_LIVE_ADVISOR_EVIDENCE=.runs/live/advisor.json \
 *     pnpm --filter @arbitra/runtime exec vitest run test/model-advisors.live.test.ts
 *
 * A rejected or unfunded credential is recorded as `unavailable`, never as passing.
 */
interface LiveEndpoint extends ProviderEndpoint { readonly modelId: string }
type Status = "passed" | "failed" | "unavailable";

const enabled = process.env["ARBITRA_LIVE_ADVISOR"] === "1" && process.env["ARBITRA_LIVE_ENDPOINTS"] !== undefined;
const evidencePath = resolve(process.env["ARBITRA_LIVE_ADVISOR_EVIDENCE"] ?? ".runs/live/advisor-live.json");
const selected = (process.env["ARBITRA_LIVE_ADVISOR_ENDPOINTS"] ?? "gemini-native,gemini-compatible-chat").split(",").map((id) => id.trim()).filter(Boolean);
const endpoints = enabled ? (JSON.parse(await readFile(resolve(process.env["ARBITRA_LIVE_ENDPOINTS"] ?? ""), "utf8")) as LiveEndpoint[]).filter(({ id }) => selected.includes(id)) : [];
const redact = (text: string) => text.replace(/(sk-(?:ant-|proj-)?|AIza|AQ\.)[A-Za-z0-9_.-]{8,}/gu, "$1<redacted>").replace(/\b(key|token|secret)=[^\s&]+/giu, "$1=<redacted>").slice(0, 400);
const dialects: Record<string, string> = { "gemini-native": "gemini", "openai-chat": "json_mode", "openai-responses": "openai_strict", "anthropic-messages": "anthropic_tool" };
const observations: Record<string, unknown>[] = [];
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(endpoint: LiveEndpoint) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-advisor-live-")); roots.push(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const base = example.models["auditor-a"]; if (base === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const advisor = { ...base, provider: endpoint.providerId, transport: endpoint.transport, modelId: endpoint.modelId, family: "gemini", independenceGroup: `advisor-${endpoint.id}`,
    capabilityTier: "balanced" as const, structuredOutputDialect: dialects[endpoint.transport] ?? "json_mode",
    supports: { ...base.supports, tools: false, parallelToolCalls: false, promptCaching: false, reasoning: false },
    limits: { contextTokens: 1_000_000, maxOutputTokens: 65_536 }, effort: { supported: [], collapse: {}, params: {} } };
  const config = runConfigSchema.parse({ ...example, mode: "testing", models: { advisor }, workflow: { modelExecution: {
    endpoints: [{ id: endpoint.id, providerId: endpoint.providerId, transport: endpoint.transport, endpoint: endpoint.endpoint, apiKeyEnvVar: endpoint.apiKeyEnvVar }],
    modelEndpoints: { advisor: endpoint.id }, maximumOutputTokens: 1_024, maximumTokens: 60_000, maximumRetries: 1, timeoutMs: 90_000,
    rateLimits: { [endpoint.providerId]: { rpm: 10, tpm: 1_000_000, maxConcurrent: 1 } },
  } } });
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const task = plan.tasks[0]; if (task === undefined) throw new Error("TASK_ABSENT");
  task.routing.capability = "fast"; task.routing.advisor = "balanced"; task.routing.advisorMaxUses = 1;
  const policy = advisorPolicySchema.parse({ models: { balanced: "advisor" }, maximumUsesPerTask: 1, maximumContextTokens: 20_000, maximumOutputTokens: 2_048, maximumTokensPerTask: 40_000 });
  validateAdvisorPolicy(config, policy);
  const requests: HttpRequest[] = [];
  const fetch = new FetchHttpClient();
  // Credentials come from the environment variable the endpoint names; only request shapes are kept.
  const provider = { client: { async send(request: HttpRequest) { requests.push(request); return fetch.send(request); } } };
  const store = new RunStore(join(root, ".runs"), "run");
  const create = () => new TaskAdvisor(store, config, new ModelActivities(store, config, provider), task, policy);
  return { root, store, requests, create, policy };
}

const executor: AdvisorExecutor = { activityId: "testing/writer/live", nodeId: "testing", round: 1 };
const context: AdvisorContext = { attempt: { id: "TASK-001/attempt-1", ordinal: 1 }, previousVerification: { status: "failed", summary: "session.test.ts: expired sessions are accepted" },
  repository: [{ path: "session.ts", content: "export function isValid(expiresAt: number, now: number): boolean {\n  return expiresAt >= 0;\n}\n" }] };

describe.skipIf(!enabled)("P13 live bounded advisor path", { timeout: 240_000 }, () => {
  it.each(endpoints.map((endpoint) => [endpoint.id, endpoint] as const))("consults a bounded advisor through %s", async (_id, endpoint) => {
    const f = await setup(endpoint);
    const checks: Record<string, boolean> = {};
    let first: AdvisorOutcome | null = null; let detail = ""; let status: Status;
    try {
      first = await f.create().consult(executor, "attempt-1", context, AbortSignal.timeout(180_000));
      // Restart: a fresh advisor over the same durable store replays the recorded advice.
      const replay = await f.create().consult(executor, "attempt-1", context, AbortSignal.timeout(60_000));
      const extra = await f.create().consult(executor, "attempt-2", context, AbortSignal.timeout(60_000));
      const use = first.status === "advice" || first.status === "failed" ? first.use : null;
      const usage = use?.usage ?? null;
      const records = (await readFile(join(f.root, ".runs", "run", "metrics", "model-activity.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const budget = JSON.parse((await f.store.readArtifact((await f.store.listArtifacts()).find(({ kind }) => kind === "model-token-budget")?.artifactId ?? "")).content) as { reservations: { activityId: string; usage: unknown }[] };
      const advisory = await f.create().advisoryInput(first, ["session.test.ts"]);
      const activityTraces = await Promise.all((await f.store.listArtifacts()).filter(({ kind }) => kind.endsWith("-trace")).map(async ({ artifactId }) =>
        JSON.parse((await f.store.readArtifact(artifactId)).content) as { attempts?: { attempt: number; outcome: string; errorCode: string | null }[]; provenance?: { providerRequestId?: string | null; usage?: { inputTokens: number | null; outputTokens: number | null } } | null }));
      const providerRequestIds = activityTraces.flatMap(({ provenance }) => typeof provenance?.providerRequestId === "string" ? [provenance.providerRequestId] : []);
      const attempts = activityTraces.flatMap(({ attempts: list }) => (list ?? []).map(({ attempt, outcome, errorCode }) => ({ attempt, outcome, errorCode })));
      const answered = activityTraces[0]?.provenance?.usage;
      checks["advice"] = first.status === "advice" && !first.replayed && use?.state === "completed";
      checks["identity"] = use?.advisorProfileId === "advisor" && use.modelId === endpoint.modelId && use.tier === "balanced" && use.activityId.startsWith("testing/advisor/") && providerRequestIds.length === 1;
      // The answering attempt's usage is always measured. After a retried transient failure the
      // activity total is unknown (the failed attempt may have been billed), so the ledger keeps
      // it null and charges the admission estimate rather than under-reporting.
      checks["measuredUsage"] = (answered?.inputTokens ?? 0) > 0 && (answered?.outputTokens ?? 0) > 0 && (attempts.length === 1
        ? JSON.stringify(usage) === JSON.stringify(answered) && use?.chargedTokens === (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
        : usage === null && use?.chargedTokens === use?.estimatedTokens);
      checks["replayNotRepaid"] = replay.status === "advice" && replay.replayed;
      checks["useLimit"] = extra.status === "exhausted" && extra.reason === "uses" && extra.usesConsumed === 1;
      // One advisor use: one provider call per transport attempt, none for the replay or the refused extra use.
      checks["providerCalls"] = f.requests.length === attempts.length && f.requests.every(({ url }) => new URL(url).origin === new URL(endpoint.endpoint).origin);
      checks["noTools"] = f.requests.every(({ body }) => { const value = body as { tools?: unknown[] }; return value.tools === undefined || value.tools.length === 0; });
      checks["trace"] = records.length === 1 && records[0]?.["harnessId"] === ADVISOR_HARNESS_ID && records[0]["modelId"] === endpoint.modelId && records[0]["outcome"] === "success"
        && JSON.stringify(records[0]["tokenUsage"]) === JSON.stringify(usage) && records[0]["advisorTokens"] === (usage === null ? null : use?.chargedTokens);
      checks["budget"] = budget.reservations.length === 1 && budget.reservations[0]?.activityId === use?.activityId && JSON.stringify(budget.reservations[0]?.usage) === JSON.stringify(usage);
      checks["advisoryInput"] = advisory.authority === "none" && advisory.advice.length === 1 && advisory.advice[0]?.modelId === endpoint.modelId;
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      const error = first.status === "failed" ? first.use.error ?? "" : "";
      status = /QUOTA|AUTH|credit|billing/iu.test(error) ? "unavailable" : failed.length === 0 ? "passed" : "failed";
      detail = failed.length === 0 ? `all checks passed (${Object.keys(checks).join(", ")})` : `failed checks: ${failed.join(", ")}${error === "" ? "" : `; use error: ${redact(error)}`}`;
      const trace = records[0] ?? {};
      observations.push({ endpointId: endpoint.id, transport: endpoint.transport, providerId: endpoint.providerId, modelId: endpoint.modelId, endpoint: endpoint.endpoint, case: "advisor", status, detail, checks,
        advisor: use === null ? null : { advisorProfileId: use.advisorProfileId, tier: use.tier, modelId: use.modelId, ordinal: use.ordinal, activityId: use.activityId, state: use.state, harnessId: trace["harnessId"] ?? null },
        limits: { maximumUses: 1, policy: f.policy }, outcomes: { first: first.status, replay: replay.status, extra: extra.status === "exhausted" ? `exhausted:${extra.reason}` : extra.status },
        usage: answered === undefined ? [] : [answered], ledgerUsage: usage, chargedTokens: use?.chargedTokens ?? null, estimatedTokens: use?.estimatedTokens ?? null, providerRequestIds, attempts, httpRequests: f.requests.length,
        advice: first.status === "advice" ? { summary: redact(first.advice.summary), recommendations: first.advice.recommendations.length, confidence: first.advice.confidence } : null,
        observedAt: new Date().toISOString(), source: "live" });
    } catch (error) {
      status = "failed"; detail = redact(error instanceof Error ? error.message : String(error));
      observations.push({ endpointId: endpoint.id, transport: endpoint.transport, providerId: endpoint.providerId, modelId: endpoint.modelId, endpoint: endpoint.endpoint, case: "advisor", status, detail, checks, httpRequests: f.requests.length, observedAt: new Date().toISOString(), source: "live" });
    }
    expect(["passed", "unavailable"], detail).toContain(status);
  });

  it("writes redacted, provenance-bearing evidence", async () => {
    await mkdir(dirname(evidencePath), { recursive: true });
    const text = JSON.stringify({ evidence: "p13-live-advisor-path", generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, observations }, null, 2);
    expect(text).not.toMatch(/sk-ant-api|sk-proj-[A-Za-z0-9]{8}|AIza[A-Za-z0-9]{8}/u);
    await writeFile(evidencePath, text);
    console.log(JSON.stringify(observations.map(({ endpointId, status, detail }) => ({ endpointId, status, detail })), null, 1));
  });
});
