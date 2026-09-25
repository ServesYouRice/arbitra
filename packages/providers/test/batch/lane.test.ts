import { describe, expect, it } from "vitest";
import { BatchRequestError } from "../../src/batch/contract.js";
import { BatchItemCancelledError, BatchItemFailedError, BatchLane, BatchSubmissionUncertainError, type BatchItemRecord, type BatchSubmissionRecord } from "../../src/batch/lane.js";
import { environment, item, settings, until } from "./fixtures.js";
import { AnthropicBatchDriver } from "../../src/batch/anthropic-batch.js";
import { TransportError } from "../../src/transport-contract.js";

const charged = (state: Awaited<ReturnType<ReturnType<typeof environment>["budget"]>>) => state.reservations.map((reservation) => ({
  activityId: reservation.activityId, estimated: reservation.estimatedTokens, usage: reservation.usage,
}));

describe("batch lane", () => {
  it("groups concurrent items and preserves item and trace identity for out-of-order, partial and failed results", async () => {
    const env = environment();
    const lane = env.lane();
    let polls = 0;
    env.driver.onStatus = async () => ({ ended: ++polls >= 2, providerStatus: polls >= 2 ? "ended" : "in_progress", jobFailure: null });
    env.driver.onResults = async () => {
      const [a, b, c] = env.driver.submits[0]?.items ?? [];
      if (a === undefined || b === undefined || c === undefined) throw new Error("FIXTURE");
      // Reverse order, one errored, one missing, plus an unknown line that must not be delivered.
      return [
        { customId: "a1-unknown", outcome: "succeeded" as const, body: { text: "stray" }, error: null },
        { customId: b.customId, outcome: "errored" as const, body: null, error: { code: "invalid_request_error", message: "bad item" } },
        { customId: a.customId, outcome: "succeeded" as const, body: { text: "answer-a", usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null } }, error: null },
      ];
    };
    const results = await Promise.allSettled([lane.execute(item("audit/a")), lane.execute(item("audit/b")), lane.execute(item("audit/c"))]);

    expect(env.driver.submits).toHaveLength(1);
    expect(env.driver.submits[0]?.items).toHaveLength(3);
    const [a, b, c] = results;
    expect(a).toMatchObject({ status: "fulfilled", value: { response: { text: "answer-a" }, provenance: {
      lane: "batch", traceId: "trace-audit/a", itemId: BatchLane.itemIdFor("audit/a"), providerJobId: "job-1", late: false,
      capability: { status: "declared_unverified" },
    } } });
    expect(b).toMatchObject({ status: "rejected", reason: { code: "invalid_request_error" } });
    expect(c).toMatchObject({ status: "rejected", reason: { code: "BATCH_RESULT_MISSING" } });
    expect(env.traces.map(({ activityId, outcome, errorCode }) => ({ activityId, outcome, errorCode }))).toEqual(expect.arrayContaining([
      { activityId: "audit/a", outcome: "completed", errorCode: null },
      { activityId: "audit/b", outcome: "failed", errorCode: "invalid_request_error" },
      { activityId: "audit/c", outcome: "failed", errorCode: "BATCH_RESULT_MISSING" },
    ]));
    // Worst case reserved before submission; unknown spend stays charged at the estimate, never zero.
    expect(charged(await env.budget())).toEqual([
      { activityId: "audit/a", estimated: 100, usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: null, cacheWriteTokens: null } },
      { activityId: "audit/b", estimated: 100, usage: null },
      { activityId: "audit/c", estimated: 100, usage: null },
    ]);
    const submission = (await lane.submissions())[0];
    expect(submission).toMatchObject({ state: "ended", providerJobId: "job-1", anomalies: ["unmatched:a1-unknown"], capabilityStatus: "declared_unverified" });

    // Restart: the completed item is reused, and a missing result is never resubmitted automatically.
    const restarted = env.lane();
    await expect(restarted.execute(item("audit/a"))).resolves.toMatchObject({ response: { text: "answer-a" } });
    await expect(restarted.execute(item("audit/c"))).rejects.toMatchObject({ code: "BATCH_RESULT_MISSING" });
    await expect(restarted.execute(item("audit/a", { fingerprint: "changed" }))).rejects.toThrow("BATCH_ITEM_INPUT_CHANGED");
    expect(env.driver.submits).toHaveLength(1);
  });

  it("fails an item stopped at the output ceiling as a non-retryable output limit, not a malformed result", async () => {
    const env = environment();
    const parse = env.driver.parse.bind(env.driver);
    env.driver.parse = (body, request) => {
      if ((body as { text?: string }).text === "truncated") throw new TransportError("OUTPUT_LIMIT", "MODEL_OUTPUT_LIMIT_REACHED: provider stopped at maximumOutputTokens", false);
      return parse(body, request);
    };
    env.driver.onResults = async () => (env.driver.submits[0]?.items ?? []).map(({ customId }) => ({ customId, outcome: "succeeded" as const, body: { text: "truncated" }, error: null }));
    await expect(env.lane().execute(item("audit/cut"))).rejects.toMatchObject({ name: "BatchItemFailedError", code: "OUTPUT_LIMIT", retryable: false });
    expect(env.traces.map(({ activityId, errorCode }) => ({ activityId, errorCode }))).toContainEqual({ activityId: "audit/cut", errorCode: "OUTPUT_LIMIT" });
    // A real driver maps the provider's ceiling stop the same way.
    const anthropic = new AnthropicBatchDriver({ endpoint: "https://batch.example/v1", apiKeyEnv: "KEY" });
    expect(() => anthropic.parse({ content: [{ type: "text", text: "{\"ok\":" }], stop_reason: "max_tokens", usage: {} }, { modelId: "m", messages: [], maximumOutputTokens: 1, responseSchema: { type: "object" } })).toThrow("MODEL_OUTPUT_LIMIT_REACHED");
  });

  it("splits submissions at the configured item limit", async () => {
    const env = environment();
    const lane = env.lane();
    const limited = { ...settings, maximumItemsPerSubmission: 2 };
    env.driver.onResults = async (jobId) => env.driver.succeedAll(Number(jobId.slice(4)) - 1);
    await Promise.all(["x/1", "x/2", "x/3"].map((id) => lane.execute(item(id, { settings: limited }))));
    expect(env.driver.submits.map(({ items }) => items.length).sort()).toEqual([1, 2]);
  });

  it("persists a lost acknowledgment as uncertain, never resubmits it, and reconciles by submission key after restart", async () => {
    const env = environment();
    env.driver.onSubmit = async () => { throw new BatchRequestError("NETWORK", "socket hang up", "unknown", true); };
    await expect(env.lane().execute(item("audit/a"))).rejects.toBeInstanceOf(BatchSubmissionUncertainError);
    const [submission] = await env.lane().submissions();
    expect(submission).toMatchObject({ state: "uncertain", providerJobId: null, reconciliation: { attempts: 1, lastResult: "not_found" } });

    // Restart while the listing still does not show the job: still uncertain, still one submission.
    await expect(env.lane().execute(item("audit/a"))).rejects.toMatchObject({ code: "BATCH_SUBMISSION_UNCERTAIN", submissionKey: submission?.key });
    expect(env.driver.submits).toHaveLength(1);

    // The provider listing now shows the job under our key.
    env.driver.onFind = async (key) => key === submission?.key ? { kind: "found", providerJobId: "job-found" } : { kind: "not_found" };
    env.driver.onResults = async () => env.driver.succeedAll(0);
    await expect(env.lane().execute(item("audit/a"))).resolves.toMatchObject({ provenance: { providerJobId: "job-found", submissionKey: submission?.key } });
    expect(env.driver.submits).toHaveLength(1);
    expect(env.driver.finds).toEqual([submission?.key, submission?.key, submission?.key]);
  });

  it("requires an operator decision when the provider cannot reconcile, and transfers the reservation of unsent work", async () => {
    const env = environment();
    env.driver.onSubmit = async () => { throw new BatchRequestError("HTTP", "Provider HTTP 502", "unknown", true); };
    env.driver.onFind = async () => ({ kind: "unsupported", reason: "no client key" });
    const error = await env.lane().execute(item("audit/a")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchSubmissionUncertainError);
    const submissionId = (error as BatchSubmissionUncertainError).submissionId;
    const [view] = await env.lane().view();
    expect(view).toMatchObject({ id: submissionId, state: "uncertain", resolvable: true, reconciliationSupport: "metadata_listing", error: { code: "HTTP" },
      reconciliation: { lastResult: "unsupported:no client key" }, items: [{ activityId: "audit/a", traceId: "trace-audit/a", attempt: 1, state: "queued", estimatedTokens: 100, usage: null }] });
    await expect(env.lane().resolveUncertain(submissionId, view?.version ?? "", { decision: "not_submitted" }, "")).rejects.toThrow("BATCH_RESOLUTION_ACTOR_REQUIRED");
    await env.lane().resolveUncertain(submissionId, view?.version ?? "", { decision: "not_submitted" }, "operator@example");
    await expect(env.lane().resolveUncertain(submissionId, view?.version ?? "", { decision: "not_submitted" }, "operator@example")).rejects.toThrow(`BATCH_SUBMISSION_NOT_UNCERTAIN:${submissionId}:abandoned`);
    env.driver.onSubmit = async () => ({ providerJobId: "job-2" });
    env.driver.onResults = async () => env.driver.succeedAll(1);
    await expect(env.lane().execute(item("audit/a"))).resolves.toMatchObject({ provenance: { attempt: 2, providerJobId: "job-2" } });
    expect(env.driver.submits).toHaveLength(2);
    const state = await env.budget();
    expect(state.reservations).toHaveLength(1);
    const record = await env.lane().item("audit/a");
    expect(record?.attempts.map(({ state: attemptState, reservationTransferred }) => ({ attemptState, reservationTransferred }))).toEqual([
      { attemptState: "not_submitted", reservationTransferred: true }, { attemptState: "succeeded", reservationTransferred: false },
    ]);
    const submissions = await env.lane().submissions();
    expect(submissions.find(({ id }) => id === submissionId)).toMatchObject({ state: "abandoned", resolution: { kind: "not_submitted", by: "operator@example" } });
  });

  it("binds an operator-found job only against the current version after checking it exists, and never twice", async () => {
    const env = environment();
    env.driver.onSubmit = async (input) => { if (input.items.some(({ customId }) => customId.includes(BatchLane.itemIdFor("audit/a")))) throw new BatchRequestError("TIMEOUT", "timed out", "unknown", true); return { providerJobId: "job-other" }; };
    const error = await env.lane().execute(item("audit/a")).catch((caught: unknown) => caught) as BatchSubmissionUncertainError;
    await env.lane().execute(item("audit/b"));
    const view = (await env.lane().view()).find(({ id }) => id === error.submissionId);
    const version = view?.version ?? "";
    expect(view).toMatchObject({ resolvable: true, providerJobId: null, resolution: null });
    // The operator inspected an older version: a later reconciliation attempt makes the decision stale.
    await env.lane().reconcile();
    await expect(env.lane().resolveUncertain(error.submissionId, version, { decision: "provider_job", providerJobId: "job-found" }, "operator")).rejects.toThrow(`BATCH_SUBMISSION_VERSION_STALE:${error.submissionId}`);
    const current = (await env.lane().view()).find(({ id }) => id === error.submissionId)?.version ?? "";
    await expect(env.lane().resolveUncertain(error.submissionId, current, { decision: "provider_job", providerJobId: "job-other" }, "operator")).rejects.toThrow(/^BATCH_PROVIDER_JOB_ALREADY_BOUND:job-other:/u);
    await expect(env.lane().resolveUncertain(error.submissionId, current, { decision: "provider_job", providerJobId: "bad id" }, "operator")).rejects.toThrow("INVALID_PROVIDER_JOB_ID");
    env.driver.onStatus = async (jobId) => { if (jobId === "job-typo") throw new BatchRequestError("HTTP", "Provider HTTP 404", "no", false); return { ended: false, providerStatus: "in_progress", jobFailure: null }; };
    await expect(env.lane().resolveUncertain(error.submissionId, current, { decision: "provider_job", providerJobId: "job-typo" }, "operator")).rejects.toThrow(/^BATCH_PROVIDER_JOB_UNVERIFIED:job-typo: /u);
    const bound = await env.lane().resolveUncertain(error.submissionId, current, { decision: "provider_job", providerJobId: "job-found" }, "operator");
    expect(bound).toMatchObject({ state: "submitted", providerJobId: "job-found", providerStatus: "in_progress", resolution: { kind: "provider_job", by: "operator", version: current, providerJobId: "job-found" } });
    await expect(env.lane().resolveUncertain(error.submissionId, BatchLane.versionOf(bound), { decision: "abandon" }, "operator")).rejects.toThrow("BATCH_SUBMISSION_NOT_UNCERTAIN");

    // Collected normally on the next execution; the item keeps its identity and is never resubmitted.
    env.driver.onStatus = async () => ({ ended: true, providerStatus: "ended", jobFailure: null });
    env.driver.onResults = async (jobId) => jobId === "job-found" ? [{ customId: `a1-${BatchLane.itemIdFor("audit/a")}`, outcome: "succeeded", body: { text: "found" }, error: null }] : [];
    await expect(env.lane().execute(item("audit/a"))).resolves.toMatchObject({ response: { text: "found" }, provenance: { traceId: "trace-audit/a", attempt: 1, providerJobId: "job-found" } });
    expect(env.driver.submits).toHaveLength(2);
  });

  it("abandons an uncertain submission's items as failed with their spend left unknown", async () => {
    const env = environment();
    env.driver.onSubmit = async () => { throw new BatchRequestError("HTTP", "Provider HTTP 503", "unknown", true); };
    const error = await env.lane().execute(item("audit/a")).catch((caught: unknown) => caught) as BatchSubmissionUncertainError;
    const before = charged(await env.budget());
    const [view] = await env.lane().view();
    await env.lane().resolveUncertain(error.submissionId, view?.version ?? "", { decision: "abandon" }, "operator");
    expect(charged(await env.budget())).toEqual(before);
    expect(before).toEqual([{ activityId: "audit/a", estimated: 100, usage: null }]);
    env.driver.onSubmit = async () => ({ providerJobId: "never" });
    await expect(env.lane().execute(item("audit/a"))).rejects.toMatchObject({ code: "BATCH_ABANDONED_BY_OPERATOR", retryable: false });
    expect(env.driver.submits).toHaveLength(1);
    expect(await env.lane().view()).toMatchObject([{ state: "abandoned", resolvable: false, resolution: { kind: "abandoned", by: "operator" }, items: [{ state: "errored", usage: null, error: { code: "BATCH_ABANDONED_BY_OPERATOR" } }] }]);
    expect(charged(await env.budget())).toEqual(before);
  });

  it("treats a crash while sending as uncertain and a crash while prepared as provably unsent", async () => {
    const env = environment();
    const hang = new Promise<never>(() => undefined);
    env.driver.onSubmit = async () => hang;
    void env.lane().execute(item("audit/sending")).catch(() => undefined);
    await until(() => env.driver.submits.length === 1);
    // Process dies here. The persisted state says "sending".
    const [sending] = [...env.backend.values.entries()].filter(([key]) => key.startsWith("submission/")).map(([, value]) => value as BatchSubmissionRecord);
    expect(sending?.state).toBe("sending");
    env.driver.onSubmit = async () => ({ providerJobId: "never" });
    await expect(env.lane().execute(item("audit/sending"))).rejects.toBeInstanceOf(BatchSubmissionUncertainError);
    expect(env.driver.submits).toHaveLength(1);

    // A prepared submission never left the process: it is abandoned and the item is sent once.
    const prepared: BatchSubmissionRecord = { ...(sending as BatchSubmissionRecord), id: "prepared-1", key: "arbitra-prepared-1", state: "prepared", members: [] };
    const itemId = BatchLane.itemIdFor("audit/prepared");
    await env.backend.save("submission/prepared-1", { ...prepared, members: [{ itemId, customId: `a1-${itemId}` }] });
    const reservation = await env.lane().item("audit/prepared");
    expect(reservation).toBeNull();
    const record: BatchItemRecord = { schemaVersion: 1, itemId, activityId: "audit/prepared", traceId: "trace-audit/prepared", fingerprint: "fingerprint-audit/prepared",
      endpointId: "endpoint", providerId: "provider", modelId: "model", attempts: [{ attempt: 1, customId: `a1-${itemId}`, reservationId: null, estimatedTokens: 100,
        reservationTransferred: false, submissionId: "prepared-1", state: "queued", cancelRequested: false, late: false, body: null, error: null, usage: null }] };
    await env.backend.save(`item/${itemId}`, record);
    env.driver.onResults = async () => env.driver.succeedAll();
    await expect(env.lane().execute(item("audit/prepared"))).resolves.toMatchObject({ response: { text: `answer:a1-${itemId}` } });
    expect(env.driver.submits).toHaveLength(2);
    expect((await env.backend.load("submission/prepared-1") as BatchSubmissionRecord).state).toBe("abandoned");
  });

  it("cancels the provider job when every item is cancelled and retains late results without resubmitting", async () => {
    const env = environment();
    env.driver.onStatus = async () => ({ ended: false, providerStatus: "in_progress", jobFailure: null });
    const controllers = [new AbortController(), new AbortController()];
    const lane = env.lane();
    const running = ["audit/a", "audit/b"].map((id, index) => lane.execute(item(id, { signal: controllers[index]?.signal ?? new AbortController().signal })));
    await until(() => env.driver.statusCalls > 0);
    controllers[0]?.abort();
    await expect(running[0]).rejects.toBeInstanceOf(BatchItemCancelledError);
    expect(env.driver.cancels).toEqual([]);
    controllers[1]?.abort();
    await expect(running[1]).rejects.toBeInstanceOf(BatchItemCancelledError);
    await until(() => env.driver.cancels.length === 1);
    expect(env.driver.cancels).toEqual(["job-1"]);

    // The provider finished one item before honouring the cancellation.
    const [a, b] = env.driver.submits[0]?.items ?? [];
    env.driver.onStatus = async () => ({ ended: true, providerStatus: "ended", jobFailure: null });
    env.driver.onResults = async () => [
      { customId: a?.customId ?? "", outcome: "succeeded", body: { text: "late", usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: null } }, error: null },
      { customId: b?.customId ?? "", outcome: "cancelled", body: null, error: { code: "canceled", message: "cancelled" } },
    ];
    await expect(env.lane().reconcile()).resolves.toMatchObject({ ended: [expect.any(String)], uncertain: [], pending: [] });
    const late = await env.lane().item("audit/a");
    expect(late?.attempts[0]).toMatchObject({ state: "succeeded", late: true, cancelRequested: true });
    expect(charged(await env.budget())).toEqual([
      { activityId: "audit/a", estimated: 100, usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: null } },
      { activityId: "audit/b", estimated: 100, usage: null },
    ]);
    // Resuming reuses the late result; the cancelled item gets one new attempt.
    await expect(env.lane().execute(item("audit/a"))).resolves.toMatchObject({ response: { text: "late" }, provenance: { late: true } });
    env.driver.onResults = async () => env.driver.succeedAll(1);
    await expect(env.lane().execute(item("audit/b"))).resolves.toMatchObject({ provenance: { attempt: 2 } });
    expect(env.driver.submits).toHaveLength(2);
    expect(env.driver.submits[1]?.items).toHaveLength(1);
  });

  it("stops waiting at the deadline, requests cancellation and keeps the job for later collection", async () => {
    const env = environment();
    env.driver.onStatus = async () => ({ ended: false, providerStatus: "in_progress", jobFailure: null });
    const error = await env.lane().execute(item("audit/a", { settings: { ...settings, maximumWaitMs: 2_500 } })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchItemFailedError);
    expect(error).toMatchObject({ code: "BATCH_DEADLINE_EXCEEDED", retryable: true });
    expect(env.driver.cancels).toEqual(["job-1"]);
    expect(env.timer.sleeps).toEqual([1_000, 1_000, 1_000]);
    const [submission] = await env.lane().submissions();
    expect(submission).toMatchObject({ state: "submitted", cancelReason: "deadline", providerStatus: "in_progress" });
    // Re-invocation attaches to the same job instead of submitting again.
    env.driver.onStatus = async () => ({ ended: true, providerStatus: "ended", jobFailure: null });
    await expect(env.lane().execute(item("audit/a"))).resolves.toMatchObject({ provenance: { late: false, providerJobId: "job-1" } });
    expect(env.driver.submits).toHaveLength(1);
  });

  it("reserves the worst case before submission and suspends without submitting when the budget cannot cover it", async () => {
    const env = environment(150);
    await expect(env.lane().execute(item("audit/a", { estimatedTokens: 200 }))).rejects.toMatchObject({ state: "SUSPENDED_BUDGET" });
    expect(env.driver.submits).toEqual([]);
  });

  it("marks a definitely rejected submission as not submitted and resubmits it without double-charging", async () => {
    const env = environment();
    env.driver.onSubmit = async () => { throw new BatchRequestError("RATE_LIMIT", "Provider rate limit", "no", true); };
    await expect(env.lane().execute(item("audit/a"))).rejects.toMatchObject({ code: "BATCH_SUBMISSION_REJECTED_RATE_LIMIT", retryable: true });
    expect(env.driver.finds).toEqual([]);
    env.driver.onSubmit = async () => ({ providerJobId: "job-ok" });
    env.driver.onResults = async () => env.driver.succeedAll(1);
    await expect(env.lane().execute(item("audit/a"))).resolves.toMatchObject({ provenance: { providerJobId: "job-ok" } });
    expect((await env.budget()).reservations).toHaveLength(1);
  });

  it("allows a bounded new attempt only after provider-confirmed expiry, and fails whole-job failures explicitly", async () => {
    const env = environment();
    env.driver.onResults = async () => (env.driver.submits.at(-1)?.items ?? []).map(({ customId }) => ({ customId, outcome: "expired" as const, body: null, error: { code: "expired", message: "expired" } }));
    await expect(env.lane().execute(item("audit/a"))).rejects.toMatchObject({ code: "BATCH_ITEM_EXPIRED", retryable: true });
    await expect(env.lane().execute(item("audit/a"))).rejects.toMatchObject({ code: "BATCH_ITEM_EXPIRED" });
    await expect(env.lane().execute(item("audit/a"))).rejects.toMatchObject({ code: "BATCH_ATTEMPTS_EXHAUSTED" });
    expect(env.driver.submits).toHaveLength(2);

    env.driver.onStatus = async () => ({ ended: true, providerStatus: "failed", jobFailure: { code: "invalid_file", message: "validation failed" } });
    env.driver.onResults = async () => [];
    await expect(env.lane().execute(item("audit/b"))).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("rejects interactive-shaped requests", async () => {
    const env = environment();
    const request = { modelId: "model", messages: [], maximumOutputTokens: 10, tools: [{ name: "read", description: "read", inputSchema: {} }] };
    await expect(env.lane().execute(item("audit/a", { request }))).rejects.toThrow("BATCH_LANE_REQUIRES_SINGLE_SHOT_REQUEST");
    await expect(env.lane().execute(item("audit/a", { estimatedTokens: 5 }))).rejects.toThrow("OUTPUT_RESERVE_MISSING_FROM_ESTIMATE");
  });
});
