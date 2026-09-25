import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { BATCH_DRIVER_DECLARATIONS } from "../../src/batch/drivers.js";
import { BatchRequestError } from "../../src/batch/contract.js";
import { BatchItemFailedError, BatchLane, BatchSubmissionUncertainError, type BatchLaneItem, type BatchLaneResult, type BatchLaneSettings, type BatchStateBackend, type BatchSubmissionRecord } from "../../src/batch/lane.js";
import { ProviderRegistry, type ProviderEndpoint } from "../../src/registry.js";
import type { InvocationTrace } from "../../src/runtime.js";
import { DurableTokenBudget } from "../../src/token-budget.js";
import type { TransportRequest, TransportResponse } from "../../src/transport-contract.js";

/**
 * P15 live batch validation: each declared batch driver is exercised through the production
 * registry and BatchLane against the real provider (submit a 2-item batch, poll to the end,
 * collect per-item results with item/trace identity, then cancel a separate 1-item batch).
 * Opt-in only:
 *
 *   ARBITRA_LIVE_BATCH=1 ARBITRA_LIVE_ENDPOINTS=tooling/live/endpoints.json \
 *   ARBITRA_LIVE_BATCH_EVIDENCE=.runs/live/batch-conformance.json \
 *     pnpm --filter @arbitra/providers exec vitest run test/conformance/live-batch.conformance.test.ts
 *
 * Resumable: lane state (item and submission records, including the provider job ID) and the
 * token budget persist under ARBITRA_LIVE_BATCH_STATE (default .runs/live/batch-state). When a
 * provider job outlives ARBITRA_LIVE_BATCH_WAIT_MS the observation is `pending` and the job is
 * left running; invoking the runner again with the same ARBITRA_LIVE_BATCH_RUN tag reattaches to
 * that job and collects its results instead of resubmitting. A new tag starts new batches.
 *
 * Endpoints whose credential is rejected or unfunded are `unavailable` with the provider's
 * error class; they never count as passing.
 */
interface LiveEndpoint extends ProviderEndpoint { readonly modelId: string }
type Status = "passed" | "failed" | "unavailable" | "unsupported" | "pending" | "not_elicited";
interface ItemEvidence {
  readonly activityId: string; readonly traceId: string; readonly customId: string | null; readonly outcome: string;
  readonly text: string | null; readonly providerRequestId: string | null; readonly usage: TransportResponse["usage"] | null; readonly late: boolean | null;
}
interface Observation {
  readonly endpointId: string; readonly transport: string; readonly providerId: string; readonly modelId: string; readonly endpoint: string;
  readonly driverId: string; readonly capabilityStatus: string; readonly case: string; readonly status: Status; readonly detail: string;
  readonly providerJobIds: readonly string[]; readonly providerStatus: string | null; readonly items: readonly ItemEvidence[];
  readonly providerRequestIds: readonly string[]; readonly usage: readonly TransportResponse["usage"][];
  readonly traces: readonly Pick<InvocationTrace, "activityId" | "attempt" | "outcome" | "errorCode">[];
  readonly runTag: string; readonly resumed: boolean; readonly observedAt: string; readonly source: "live";
}

const enabled = process.env["ARBITRA_LIVE_BATCH"] === "1" && process.env["ARBITRA_LIVE_ENDPOINTS"] !== undefined;
const evidencePath = resolve(process.env["ARBITRA_LIVE_BATCH_EVIDENCE"] ?? ".runs/live/batch-conformance.json");
const stateRoot = resolve(process.env["ARBITRA_LIVE_BATCH_STATE"] ?? ".runs/live/batch-state");
const runTag = process.env["ARBITRA_LIVE_BATCH_RUN"] ?? "p15";
const waitMs = Number(process.env["ARBITRA_LIVE_BATCH_WAIT_MS"] ?? 20 * 60_000);
const pollMs = Number(process.env["ARBITRA_LIVE_BATCH_POLL_MS"] ?? 20_000);
const cancelWaitMs = Number(process.env["ARBITRA_LIVE_BATCH_CANCEL_WAIT_MS"] ?? 5 * 60_000);
const observations: Observation[] = [];
const redact = (text: string) => text.replace(/(sk-(?:ant-|proj-)?|AIza|AQ\.)[A-Za-z0-9_.-]{8,}/gu, "$1<redacted>").replace(/\b(key|token|secret)=[^\s&]+/giu, "$1=<redacted>").slice(0, 400);

/** The lane never deadline-cancels a live job on its own; the runner's wait is bounded separately so a job can be resumed. */
const settings: BatchLaneSettings = { pollIntervalMs: pollMs, maximumWaitMs: 24 * 60 * 60_000, maximumItemsPerSubmission: 10, collectWindowMs: 1_000, maximumAttempts: 1 };

/** Keyed lane/budget state as one JSON file per key, written atomically (temp file + rename). */
function fileBackend(directory: string): BatchStateBackend & { loadRaw(name: string): Promise<unknown>; saveRaw(name: string, value: unknown): Promise<void> } {
  const file = (key: string) => join(directory, `${key.replace("/", "__")}.json`);
  const load = async (path: string) => { try { return JSON.parse(await readFile(path, "utf8")) as unknown; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } };
  const save = async (path: string, value: unknown) => { await mkdir(directory, { recursive: true }); await writeFile(`${path}.tmp`, JSON.stringify(value, null, 1)); await rename(`${path}.tmp`, path); };
  return {
    load: (key) => load(file(key)), save: (key, value) => save(file(key), value),
    async list(prefix) {
      const names = await readdir(directory).catch(() => [] as string[]);
      return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5).replace("__", "/")).filter((key) => key.startsWith(prefix)).sort();
    },
    loadRaw: (name) => load(join(directory, name)), saveRaw: (name, value) => save(join(directory, name), value),
  };
}

function harness(endpoint: LiveEndpoint) {
  const registry = new ProviderRegistry([endpoint]);
  const backend = fileBackend(join(stateRoot, runTag, endpoint.id));
  const traces: InvocationTrace[] = [];
  const budget = new DurableTokenBudget(200_000, { load: () => backend.loadRaw("budget.json"), save: (state) => backend.saveRaw("budget.json", state) });
  const lane = new BatchLane({ namespace: `p15-live-${runTag}`, driver: (endpointId) => registry.batchDriver(endpointId), budget, backend,
    traces: { record: (trace) => { traces.push(trace); } }, requestTimeoutMs: 60_000 });
  const item = (name: string, request: Omit<TransportRequest, "modelId">, signal = new AbortController().signal): BatchLaneItem => ({
    activityId: `batch-live/${endpoint.id}/${name}`, traceId: `trace/${endpoint.id}/${runTag}/${name}`, fingerprint: JSON.stringify(request),
    endpointId: endpoint.id, providerId: endpoint.providerId, modelId: endpoint.modelId, request: { ...request, modelId: endpoint.modelId },
    estimatedTokens: 2_000, settings, signal,
  });
  const submissions = async (): Promise<BatchSubmissionRecord[]> => {
    const keys = await backend.list("submission/");
    return (await Promise.all(keys.map((key) => backend.load(key)))) as BatchSubmissionRecord[];
  };
  return { driver: registry.batchDriver(endpoint.id), lane, item, traces, submissions };
}

type Settled = PromiseSettledResult<BatchLaneResult>;
interface Classified { readonly code: string; unavailable: boolean; message: string }
/** Unavailable means the provider refused the account before creating billable work. */
function classify(reason: unknown): Classified {
  const code = reason instanceof BatchItemFailedError || reason instanceof BatchRequestError || reason instanceof BatchSubmissionUncertainError ? reason.code : "UNKNOWN";
  const message = redact(reason instanceof Error ? reason.message : String(reason));
  return { code, unavailable: /^(?:BATCH_SUBMISSION_REJECTED_)?(?:QUOTA|AUTH)$/u.test(code), message: message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message };
}

/**
 * A generic precondition refusal (Gemini answers FAILED_PRECONDITION when the project's tier has
 * no batch access) is ambiguous: it could also be this driver's encoding. Resubmitting the
 * smallest possible request through the same driver tells them apart. If the minimal batch is
 * accepted, the refusal was the driver's and the probe job is cancelled at once.
 */
async function discriminatePrecondition(driver: ReturnType<typeof harness>["driver"], endpoint: LiveEndpoint, failures: Classified[]): Promise<string> {
  if (failures.length === 0 || !failures.every(({ message }) => /FAILED_PRECONDITION/u.test(message))) return "";
  try {
    const { providerJobId } = await driver.submit({ submissionKey: `arbitra-p15-probe-${Date.now()}`, modelId: endpoint.modelId,
      items: [{ customId: "probe", request: { modelId: endpoint.modelId, messages: [{ role: "user", content: "Reply with: ok" }], maximumOutputTokens: 16 } }] }, AbortSignal.timeout(60_000));
    await driver.cancel(providerJobId, AbortSignal.timeout(60_000)).catch(() => undefined);
    return ` | minimal probe batch ${providerJobId} was ACCEPTED (then cancelled): the refusal is specific to this driver's encoding`;
  } catch (error) {
    const probe = classify(error);
    if (!/FAILED_PRECONDITION/u.test(probe.message)) return ` | minimal probe refused differently: ${probe.code}: ${probe.message}`;
    for (const failure of failures) failure.unavailable = true;
    return " | a minimal 1-item batch through the same driver is refused identically, so the account/tier has no batch access";
  }
}

const endpoints: LiveEndpoint[] = enabled ? JSON.parse(await readFile(resolve(process.env["ARBITRA_LIVE_ENDPOINTS"] ?? ""), "utf8")) as LiveEndpoint[] : [];
const batchEndpoints = endpoints.filter((endpoint) => new ProviderRegistry([endpoint]).supportsBatch(endpoint.id));
const system = { role: "system" as const, content: "You are a terse assistant used for batch conformance testing." };
const answerSchema = { type: "object", properties: { capital: { type: "string" } }, required: ["capital"], additionalProperties: false };
const unavailableDrivers = new Set<string>();

describe.skipIf(!enabled)("P15 live batch validation", () => {
  it("covers every declared batch driver with a configured endpoint", () => {
    const configured = new Set(batchEndpoints.map((endpoint) => new ProviderRegistry([endpoint]).batchDriver(endpoint.id).id));
    expect(BATCH_DRIVER_DECLARATIONS.map(({ driverId }) => driverId).filter((driverId) => !configured.has(driverId))).toEqual([]);
  });

  describe.each(batchEndpoints)("$id ($transport, $modelId)", (endpoint) => {
    it("submits a 2-item batch, polls it to the end and collects per-item results with identity", { timeout: waitMs + 180_000 }, async () => {
      const { driver, lane, item, traces, submissions } = harness(endpoint);
      const resumed = (await submissions()).length > 0;
      const items = [
        item("item-1", { messages: [system, { role: "user", content: "Reply with exactly the word: alpha" }], maximumOutputTokens: 256 }),
        item("item-2", { messages: [system, { role: "user", content: "What is the capital of France? Answer as JSON." }], responseSchema: answerSchema, maximumOutputTokens: 256 }),
      ];
      const settled = Promise.allSettled(items.map((entry) => lane.execute(entry)));
      const outcome = await Promise.race([settled, delay(waitMs, "timeout" as const)]);
      const records = await submissions();
      const jobIds = [...new Set(records.flatMap(({ providerJobId }) => providerJobId === null ? [] : [providerJobId]))];
      const providerStatus = records.at(-1)?.providerStatus ?? null;
      let status: Status; let detail: string; let evidence: ItemEvidence[];
      if (outcome === "timeout") {
        status = "pending";
        detail = `no result within ${waitMs} ms; job left running (state ${records.map(({ state }) => state).join(",")}); rerun with ARBITRA_LIVE_BATCH_RUN=${runTag} to collect`;
        evidence = items.map(({ activityId, traceId }) => ({ activityId, traceId, customId: null, outcome: "waiting", text: null, providerRequestId: null, usage: null, late: null }));
      } else {
        evidence = outcome.map((result: Settled, index) => {
          const { activityId, traceId } = items[index] as BatchLaneItem;
          if (result.status === "rejected") return { activityId, traceId, customId: null, outcome: `${classify(result.reason).code}: ${classify(result.reason).message}`, text: null, providerRequestId: null, usage: null, late: null };
          const { response, provenance } = result.value;
          return { activityId, traceId: provenance.traceId, customId: provenance.customId, outcome: "succeeded", text: (response.text ?? "").slice(0, 80),
            providerRequestId: response.providerRequestId, usage: response.usage, late: provenance.late };
        });
        const failures = outcome.flatMap((result) => result.status === "rejected" ? [classify(result.reason)] : []);
        const eligibility = await discriminatePrecondition(driver, endpoint, failures);
        const values = outcome.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const [first, second] = values;
        const checks = {
          bothSucceeded: values.length === 2,
          oneProviderJob: new Set(values.map(({ provenance }) => provenance.providerJobId)).size === 1 && values[0]?.provenance.providerJobId !== null,
          itemIdentity: values.every(({ provenance }, index) => provenance.traceId === items[index]?.traceId && provenance.driverId === driver.id && provenance.lane === "batch")
            && new Set(values.map(({ provenance }) => provenance.customId)).size === values.length,
          text: /alpha/iu.test(first?.response.text ?? ""),
          structured: /paris/iu.test(String((second?.response.structured as { capital?: unknown } | null)?.capital ?? "")),
          usage: values.every(({ response }) => (response.usage.inputTokens ?? 0) > 0 && (response.usage.outputTokens ?? 0) > 0),
        };
        const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
        status = failures.length > 0 && failures.every(({ unavailable }) => unavailable) ? "unavailable" : failed.length === 0 ? "passed" : "failed";
        detail = failures.length > 0 ? [...new Set(failures.map(({ code, message }) => `${code}: ${message}`))].join(" | ") + eligibility : failed.length === 0 ? `all checks passed (${Object.keys(checks).join(", ")})` : `failed checks: ${failed.join(", ")}`;
      }
      if (status === "unavailable") unavailableDrivers.add(driver.id);
      const responses = evidence.flatMap(({ usage }) => usage === null ? [] : [usage]);
      observations.push({ endpointId: endpoint.id, transport: endpoint.transport, providerId: endpoint.providerId, modelId: endpoint.modelId, endpoint: endpoint.endpoint,
        driverId: driver.id, capabilityStatus: driver.declaration.status, case: `batch:${driver.id}`, status, detail, providerJobIds: jobIds, providerStatus, items: evidence,
        providerRequestIds: evidence.flatMap(({ providerRequestId }) => providerRequestId === null ? [] : [providerRequestId]), usage: responses,
        traces: traces.map(({ activityId, attempt, outcome: traced, errorCode }) => ({ activityId, attempt, outcome: traced, errorCode })),
        runTag, resumed, observedAt: new Date().toISOString(), source: "live" });
      expect(["passed", "unavailable", "pending"]).toContain(status);
    });

    it("reconciles through the provider's listing without spend (unknown submission key)", async () => {
      const { driver } = harness(endpoint);
      let status: Status; let detail: string;
      try {
        const lookup = await driver.find(`arbitra-p15-absent-${Date.now()}`, endpoint.modelId, AbortSignal.timeout(60_000));
        // Operator-only reconciliation makes no provider call, so it proves nothing live.
        status = driver.declaration.reconciliation === "operator_only" ? (lookup.kind === "unsupported" ? "unsupported" : "failed") : lookup.kind === "not_found" ? "passed" : "failed"; detail = `declared=${driver.declaration.reconciliation} lookup=${lookup.kind}${"reason" in lookup ? `: ${redact(lookup.reason)}` : ""}`;
      } catch (error) { const failure = classify(error); status = failure.unavailable ? "unavailable" : "failed"; detail = `${failure.code}: ${failure.message}`; }
      observations.push({ endpointId: endpoint.id, transport: endpoint.transport, providerId: endpoint.providerId, modelId: endpoint.modelId, endpoint: endpoint.endpoint,
        driverId: driver.id, capabilityStatus: driver.declaration.status, case: `batch_lookup:${driver.id}`, status, detail, providerJobIds: [], providerStatus: null, items: [],
        providerRequestIds: [], usage: [], traces: [], runTag, resumed: false, observedAt: new Date().toISOString(), source: "live" });
      expect(["passed", "unavailable", "unsupported"]).toContain(status);
    });

    it("cancels a separate 1-item batch at the provider", { timeout: cancelWaitMs + 180_000 }, async () => {
      const { driver, lane, item, traces, submissions } = harness(endpoint);
      const base = { endpointId: endpoint.id, transport: endpoint.transport, providerId: endpoint.providerId, modelId: endpoint.modelId, endpoint: endpoint.endpoint,
        driverId: driver.id, capabilityStatus: driver.declaration.status, case: `batch_cancel:${driver.id}`, providerRequestIds: [], usage: [], runTag, resumed: false, source: "live" as const };
      if (unavailableDrivers.has(driver.id)) {
        observations.push({ ...base, status: "unavailable", detail: "not attempted: the submission case was refused for this account", providerJobIds: [], providerStatus: null, items: [], traces: [], observedAt: new Date().toISOString() });
        return;
      }
      const controller = new AbortController();
      // A fresh activity per invocation: a cancelled job is never reattached.
      const entry = item(`cancel-${Date.now()}`, { messages: [system, { role: "user", content: "Write a 400-word essay about rivers." }], maximumOutputTokens: 1_024 }, controller.signal);
      const execution = lane.execute(entry).then(() => "completed", (error: unknown) => classify(error).code);
      const deadline = Date.now() + 120_000;
      let submission: BatchSubmissionRecord | undefined;
      while (Date.now() < deadline) {
        submission = (await submissions()).find((record) => record.members.some(({ customId }) => customId.endsWith(BatchLane.itemIdFor(entry.activityId))));
        if (submission !== undefined && submission.state !== "prepared" && submission.state !== "sending") break;
        if (await Promise.race([execution, delay(250, null)]) !== null) break;
      }
      let status: Status; let detail: string; let providerStatus: string | null = null;
      if (submission?.providerJobId == null) {
        const code = await Promise.race([execution, delay(1_000, "still waiting")]);
        status = /QUOTA|AUTH/u.test(code) ? "unavailable" : "failed"; detail = `no provider job to cancel (${code}; submission ${submission?.state ?? "absent"})`;
      } else {
        const jobId = submission.providerJobId;
        controller.abort();
        const code = await execution;
        const stopAt = Date.now() + cancelWaitMs;
        for (;;) {
          const current = await driver.status(jobId, AbortSignal.timeout(60_000));
          providerStatus = current.providerStatus;
          if (current.ended || Date.now() >= stopAt) break;
          await delay(Math.min(pollMs, 10_000));
        }
        const record = (await submissions()).find(({ id }) => id === submission?.id);
        const cancelledAtProvider = /cancel/iu.test(providerStatus ?? "");
        const cancelRequested = record?.cancelReason === "all_items_cancelled" && record.error?.code !== "BATCH_CANCEL_FAILED";
        // A job that finished before the cancel landed keeps its late result; reconcile collects it without resubmitting.
        if (!cancelledAtProvider && /succeeded|ended|completed/iu.test(providerStatus ?? "")) await lane.reconcile();
        const attempt = (await lane.item(entry.activityId))?.attempts.at(-1);
        status = code === "CANCELLED" && cancelRequested && cancelledAtProvider ? "passed" : code === "CANCELLED" && cancelRequested && attempt?.late === true ? "not_elicited" : "failed";
        detail = `caller=${code} laneCancel=${record?.cancelReason ?? "none"}${record?.error === null || record?.error === undefined ? "" : ` error=${redact(record.error.message)}`} provider=${providerStatus ?? "unknown"} item=${attempt?.state ?? "absent"} late=${String(attempt?.late ?? null)}`;
      }
      observations.push({ ...base, status, detail, providerJobIds: submission?.providerJobId == null ? [] : [submission.providerJobId], providerStatus,
        items: [{ activityId: entry.activityId, traceId: entry.traceId, customId: null, outcome: status, text: null, providerRequestId: null, usage: null, late: null }],
        traces: traces.map(({ activityId, attempt, outcome, errorCode }) => ({ activityId, attempt, outcome, errorCode })), observedAt: new Date().toISOString() });
      expect(["passed", "unavailable", "not_elicited"]).toContain(status);
    });
  });

  it("writes redacted, provenance-bearing evidence", async () => {
    await mkdir(dirname(evidencePath), { recursive: true });
    const report = { evidence: "p15-live-batch-validation", generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version,
      settings: { waitMs, pollMs, cancelWaitMs, runTag }, declarations: BATCH_DRIVER_DECLARATIONS.map(({ driverId, transport, status }) => ({ driverId, transport, status })), observations };
    const text = JSON.stringify(report, null, 2);
    expect(text).not.toMatch(/sk-ant-api|sk-proj-[A-Za-z0-9]{8}|AIza[A-Za-z0-9]{8}/u);
    await writeFile(evidencePath, text);
    console.log(JSON.stringify(observations.map(({ endpointId, case: name, status, detail, providerJobIds }) => ({ endpointId, case: name, status, detail, providerJobIds })), null, 1));
  });
});
