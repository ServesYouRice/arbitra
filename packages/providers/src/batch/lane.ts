import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderBudgetSuspendedError, type InvocationBudget, type RuntimeTimer, type TraceSink } from "../runtime.js";
import type { TransportRequest, TransportResponse, TransportUsage } from "../transport-contract.js";
import { BatchRequestError, type BatchCapabilityDeclaration, type BatchDriver, type BatchJobStatus, type BatchRawItemResult } from "./contract.js";

/** Operator policy for one batch lane. Validated by the run configuration schema. */
export interface BatchLaneSettings {
  readonly pollIntervalMs: number;
  /** After this long without an ended job the lane requests cancellation and stops waiting. */
  readonly maximumWaitMs: number;
  readonly maximumItemsPerSubmission: number;
  /** How long concurrent items are collected into one submission. */
  readonly collectWindowMs: number;
  /** Attempts per item. A new attempt only follows provider-confirmed non-processing. */
  readonly maximumAttempts: number;
}

/**
 * Keyed durable storage. `save` must commit atomically before resolving. Items and
 * submissions are stored under separate keys so concurrent lanes never rewrite each
 * other's records.
 */
export interface BatchStateBackend {
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}

export interface BatchLaneOptions {
  /** Run identity. It is part of every submission key so runs never reconcile each other's jobs. */
  readonly namespace: string;
  readonly driver: (endpointId: string) => BatchDriver;
  readonly budget: InvocationBudget;
  readonly backend: BatchStateBackend;
  readonly traces?: TraceSink;
  readonly now?: () => number;
  readonly timer?: RuntimeTimer;
  /** Per HTTP call to the batch API (submit, poll, list, cancel, results). */
  readonly requestTimeoutMs: number;
  /** Consecutive polling failures tolerated before waiting items fail (the job is kept). */
  readonly maximumPollFailures?: number;
}

export interface BatchLaneItem {
  readonly activityId: string;
  /** Durable trace identity that the caller records the terminal trace under. */
  readonly traceId: string;
  /** Request identity. A changed request under the same activity is rejected. */
  readonly fingerprint: string;
  readonly endpointId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly request: TransportRequest;
  /** Worst-case admission estimate including the output reserve. Reserved before submission. */
  readonly estimatedTokens: number;
  readonly settings: BatchLaneSettings;
  readonly signal: AbortSignal;
}

export interface BatchItemProvenance {
  readonly lane: "batch";
  readonly driverId: string;
  readonly capability: BatchCapabilityDeclaration;
  readonly itemId: string;
  readonly traceId: string;
  readonly customId: string;
  readonly attempt: number;
  readonly submissionId: string;
  readonly submissionKey: string;
  readonly providerJobId: string | null;
  /** The result arrived after this item's cancellation was requested. */
  readonly late: boolean;
}

export interface BatchLaneResult { readonly response: TransportResponse; readonly provenance: BatchItemProvenance }

export type AttemptState = "queued" | "submitted" | "succeeded" | "errored" | "cancelled" | "expired" | "missing" | "not_submitted";
export type SubmissionState = "prepared" | "sending" | "submitted" | "uncertain" | "rejected" | "ended" | "abandoned";
interface Failure { readonly code: string; readonly message: string }

export interface BatchAttemptRecord {
  readonly attempt: number;
  readonly customId: string;
  readonly reservationId: string | null;
  readonly estimatedTokens: number;
  /** The reservation moved to a later attempt because this one was never sent. */
  readonly reservationTransferred: boolean;
  readonly submissionId: string | null;
  readonly state: AttemptState;
  readonly cancelRequested: boolean;
  readonly late: boolean;
  readonly body: unknown;
  readonly error: Failure | null;
  /** Null means unknown: the reservation stays charged at its estimate. Never reported as zero. */
  readonly usage: TransportUsage | null;
}
export interface BatchItemRecord {
  readonly schemaVersion: 1;
  readonly itemId: string;
  readonly activityId: string;
  readonly traceId: string;
  readonly fingerprint: string;
  readonly endpointId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly attempts: readonly BatchAttemptRecord[];
}
export interface BatchSubmissionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  /** Client-supplied idempotency/reconciliation key sent to the provider where supported. */
  readonly key: string;
  readonly endpointId: string;
  readonly driverId: string;
  readonly capabilityStatus: BatchCapabilityDeclaration["status"];
  readonly modelId: string;
  readonly members: readonly { readonly itemId: string; readonly customId: string }[];
  readonly state: SubmissionState;
  readonly providerJobId: string | null;
  readonly providerStatus: string | null;
  readonly pollIntervalMs: number;
  readonly maximumWaitMs: number;
  readonly preparedAt: number;
  readonly sentAt: number | null;
  readonly submittedAt: number | null;
  readonly deadlineAt: number | null;
  readonly lastPolledAt: number | null;
  readonly endedAt: number | null;
  readonly cancelRequestedAt: number | null;
  readonly cancelReason: "deadline" | "all_items_cancelled" | null;
  readonly reconciliation: { readonly attempts: number; readonly lastResult: string | null };
  readonly resolution: null | { readonly kind: "provider_job" | "not_submitted"; readonly by: string; readonly at: number };
  readonly error: Failure | null;
  /** Result lines that matched no member, or duplicated one. Recorded, never delivered. */
  readonly anomalies: readonly string[];
}

export class BatchSubmissionUncertainError extends Error {
  readonly code = "BATCH_SUBMISSION_UNCERTAIN" as const;
  readonly resumable = true;
  constructor(readonly submissionId: string, readonly submissionKey: string, readonly reason: string) {
    super(`BATCH_SUBMISSION_UNCERTAIN:${submissionId}: the provider may have accepted batch "${submissionKey}" (${reason}). `
      + "It will not be resubmitted automatically. Confirm in the provider console, then resolve the submission with the provider job ID or as not submitted.");
    this.name = "BatchSubmissionUncertainError";
  }
}
export class BatchItemFailedError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(`${code}: ${message}`); this.name = "BatchItemFailedError"; }
}
export class BatchItemCancelledError extends Error {
  readonly code = "CANCELLED" as const;
  constructor(readonly customId: string) { super(`Batch item ${customId} cancelled; any late result is retained`); this.name = "BatchItemCancelledError"; }
}

interface Waiter {
  readonly item: BatchLaneItem;
  readonly itemId: string;
  readonly customId: string;
  readonly resolve: (value: BatchLaneResult) => void;
  readonly reject: (error: unknown) => void;
}
interface Group { readonly endpointId: string; readonly modelId: string; readonly settings: BatchLaneSettings; readonly customIds: string[]; cancelTimer: () => void }
type Plan =
  | { readonly action: "deliver"; readonly attempt: BatchAttemptRecord }
  | { readonly action: "enqueue"; readonly attempt: BatchAttemptRecord }
  | { readonly action: "attach"; readonly attempt: BatchAttemptRecord; readonly submissionId: string }
  | { readonly action: "reconcile"; readonly attempt: BatchAttemptRecord; readonly submissionId: string };

const systemTimer: RuntimeTimer = {
  timeout(milliseconds, callback) { const handle = setTimeout(callback, milliseconds); return () => clearTimeout(handle); },
  sleep: async (milliseconds, signal) => delay(milliseconds, undefined, signal === undefined ? {} : { signal }),
};

/**
 * The explicit batch lane. Items are reserved against the budget at their worst-case
 * estimate, grouped per endpoint/model into submissions, and tracked through durable
 * item and submission records. A submission whose acknowledgment may have been lost is
 * persisted as uncertain and only ever reconciled or resolved by the operator.
 */
export class BatchLane {
  readonly #now: () => number;
  readonly #timer: RuntimeTimer;
  readonly #waiters = new Map<string, Waiter>();
  readonly #groups = new Map<string, Group>();
  readonly #pollers = new Map<string, Promise<void>>();
  #writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BatchLaneOptions) {
    if (options.namespace.trim() === "") throw new Error("INVALID_BATCH_NAMESPACE");
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) throw new Error("INVALID_BATCH_REQUEST_TIMEOUT");
    this.#now = options.now ?? (() => Date.now());
    this.#timer = options.timer ?? systemTimer;
  }

  static itemIdFor(activityId: string): string { return digest(activityId).slice(0, 40); }

  async execute(item: BatchLaneItem): Promise<BatchLaneResult> {
    validateItem(item);
    if (item.signal.aborted) throw new BatchItemCancelledError(LaneIds.custom(1, BatchLane.itemIdFor(item.activityId)));
    const itemId = BatchLane.itemIdFor(item.activityId);
    const plan = await this.#serial(() => this.#plan(item, itemId));
    if (plan.action === "deliver") return this.#resultOf(item, itemId, plan.attempt);
    const customId = plan.attempt.customId;
    if (this.#waiters.has(customId)) throw new Error(`BATCH_ITEM_ALREADY_WAITING:${customId}`);
    const promise = new Promise<BatchLaneResult>((resolve, reject) => {
      // A settled waiter leaves the map at once, so pollers never see answered items as waiting.
      const settle = <T>(finish: (value: T) => void) => (value: T): void => {
        if (this.#waiters.get(customId)?.item === item) this.#waiters.delete(customId);
        finish(value);
      };
      this.#waiters.set(customId, { item, itemId, customId, resolve: settle(resolve), reject: settle(reject) });
    });
    const abort = (): void => { void this.#cancelItem(customId); };
    item.signal.addEventListener("abort", abort, { once: true });
    if (item.signal.aborted) abort();
    try {
      if (plan.action === "enqueue") this.#enqueue(item, customId);
      else if (plan.action === "attach") this.#poll(plan.submissionId);
      else void this.#reconcileThenPoll(plan.submissionId).catch((error: unknown) => { this.#waiters.get(customId)?.reject(error); });
      return await promise;
    } finally {
      item.signal.removeEventListener("abort", abort);
      if (this.#waiters.get(customId)?.item === item) this.#waiters.delete(customId);
    }
  }

  /** Reconciles every unfinished submission once. Collects late results; never resubmits. */
  async reconcile(): Promise<{ readonly ended: readonly string[]; readonly uncertain: readonly string[]; readonly pending: readonly string[] }> {
    const ended: string[] = []; const uncertain: string[] = []; const pending: string[] = [];
    for (const key of await this.options.backend.list("submission/")) {
      const id = key.slice("submission/".length);
      let submission = await this.#submission(id);
      if (submission.state === "prepared") submission = await this.#serial(() => this.#abandonUnsent(id));
      if (submission.state === "sending" || submission.state === "uncertain") submission = await this.#reconcileSubmission(id);
      if (submission.state === "submitted") {
        try { submission = await this.#pollOnce(id); } catch { /* recorded as pending; retried on the next reconcile */ }
      }
      if (submission.state === "ended") ended.push(id);
      else if (submission.state === "uncertain") uncertain.push(id);
      else if (submission.state === "submitted") pending.push(id);
    }
    return { ended, uncertain, pending };
  }

  /** Operator decision for an uncertain submission. The only way one leaves that state without a provider match. */
  async resolveUncertain(submissionId: string, resolution: { readonly providerJobId: string } | { readonly notSubmitted: true }, by: string): Promise<BatchSubmissionRecord> {
    if (by.trim() === "") throw new Error("BATCH_RESOLUTION_ACTOR_REQUIRED");
    return this.#serial(async () => {
      const submission = await this.#submission(submissionId);
      if (submission.state !== "uncertain" && submission.state !== "sending") throw new Error(`BATCH_SUBMISSION_NOT_UNCERTAIN:${submissionId}:${submission.state}`);
      const at = this.#now();
      if ("providerJobId" in resolution) {
        if (resolution.providerJobId.trim() === "") throw new Error("INVALID_PROVIDER_JOB_ID");
        return this.#markSubmitted(submission, resolution.providerJobId, { kind: "provider_job", by, at });
      }
      await this.#updateMembers(submission, (attempt) => attempt.state === "queued" ? { ...attempt, state: "not_submitted" } : attempt);
      const next: BatchSubmissionRecord = { ...submission, state: "abandoned", resolution: { kind: "not_submitted", by, at } };
      await this.#saveSubmission(next);
      return next;
    });
  }

  async submissions(): Promise<readonly BatchSubmissionRecord[]> {
    const keys = await this.options.backend.list("submission/");
    return Promise.all(keys.map((key) => this.#submission(key.slice("submission/".length))));
  }

  async item(activityId: string): Promise<BatchItemRecord | null> { return this.#item(BatchLane.itemIdFor(activityId)); }

  // ---- planning --------------------------------------------------------------------------

  async #plan(item: BatchLaneItem, itemId: string): Promise<Plan> {
    let record = await this.#item(itemId);
    if (record !== null && (record.fingerprint !== item.fingerprint || record.endpointId !== item.endpointId || record.modelId !== item.modelId)) {
      throw new Error("BATCH_ITEM_INPUT_CHANGED");
    }
    const current = record?.attempts.at(-1);
    if (current !== undefined) {
      if (current.state === "succeeded") return { action: "deliver", attempt: current };
      if (current.state === "errored") throw new BatchItemFailedError(current.error?.code ?? "ERRORED", current.error?.message ?? "Batch item failed", false);
      if (current.state === "missing") throw new BatchItemFailedError("BATCH_RESULT_MISSING", "The provider ended the job without a result for this item; spend is unknown and it is not resubmitted automatically", false);
      if (current.state === "submitted" && current.submissionId !== null) return { action: "attach", attempt: current, submissionId: current.submissionId };
      if (current.state === "queued") {
        if (current.submissionId === null) return { action: "enqueue", attempt: current };
        const submission = await this.#submission(current.submissionId);
        if (submission.state === "prepared") {
          await this.#abandonUnsent(submission.id);
          const reloaded = (await this.#item(itemId))?.attempts.at(-1);
          if (reloaded === undefined) throw new Error("BATCH_ITEM_STATE_LOST");
          return { action: "enqueue", attempt: reloaded };
        }
        if (submission.state === "sending" || submission.state === "uncertain") return { action: "reconcile", attempt: current, submissionId: submission.id };
        if (submission.state === "submitted") return { action: "attach", attempt: current, submissionId: submission.id };
        throw new Error(`BATCH_STATE_INCONSISTENT:${submission.id}:${submission.state}`);
      }
      // cancelled, expired or not_submitted: the provider confirmed the item was not processed.
      if (record !== null && record.attempts.length >= item.settings.maximumAttempts) {
        throw new BatchItemFailedError("BATCH_ATTEMPTS_EXHAUSTED", `Item ended ${current.state} after ${record.attempts.length} attempt(s)`, false);
      }
    }
    const attemptNumber = (record?.attempts.length ?? 0) + 1;
    let reservationId: string | null;
    let prior = record?.attempts ?? [];
    if (current !== undefined && current.state === "not_submitted" && !current.reservationTransferred && current.reservationId !== null) {
      // Nothing reached the provider; move the reservation rather than double-charging.
      reservationId = current.reservationId;
      prior = [...prior.slice(0, -1), { ...current, reservationTransferred: true }];
    } else {
      const reservation = await this.options.budget.reserve(item.activityId, item.estimatedTokens);
      if (!reservation.allowed) throw new ProviderBudgetSuspendedError(reservation.reason ?? "Batch budget preflight refused submission");
      reservationId = reservation.reservationId ?? null;
    }
    const attempt: BatchAttemptRecord = {
      attempt: attemptNumber, customId: LaneIds.custom(attemptNumber, itemId), reservationId, estimatedTokens: item.estimatedTokens,
      reservationTransferred: false, submissionId: null, state: "queued", cancelRequested: false, late: false, body: null, error: null, usage: null,
    };
    record = {
      schemaVersion: 1, itemId, activityId: item.activityId, traceId: item.traceId, fingerprint: item.fingerprint,
      endpointId: item.endpointId, providerId: item.providerId, modelId: item.modelId, attempts: [...prior, attempt],
    };
    await this.#saveItem(record);
    return { action: "enqueue", attempt };
  }

  // ---- submission --------------------------------------------------------------------------

  #enqueue(item: BatchLaneItem, customId: string): void {
    const groupKey = `${item.endpointId}\u0000${item.modelId}`;
    let group = this.#groups.get(groupKey);
    if (group === undefined) {
      const created: Group = { endpointId: item.endpointId, modelId: item.modelId, settings: item.settings, customIds: [], cancelTimer: () => undefined };
      created.cancelTimer = this.#timer.timeout(item.settings.collectWindowMs, () => { void this.#flushSafely(groupKey, created); });
      this.#groups.set(groupKey, created);
      group = created;
    }
    group.customIds.push(customId);
    if (group.customIds.length >= group.settings.maximumItemsPerSubmission) { group.cancelTimer(); void this.#flushSafely(groupKey, group); }
  }

  async #flushSafely(groupKey: string, group: Group): Promise<void> {
    try { await this.#flush(groupKey, group); }
    catch (error) {
      for (const customId of group.customIds) this.#waiters.get(customId)?.reject(error);
    }
  }

  async #flush(groupKey: string, group: Group): Promise<void> {
    if (this.#groups.get(groupKey) === group) this.#groups.delete(groupKey);
    const members = group.customIds.flatMap((customId) => { const waiter = this.#waiters.get(customId); return waiter === undefined ? [] : [waiter]; });
    if (members.length === 0) return;
    const driver = this.options.driver(group.endpointId);
    const id = digest(JSON.stringify([this.options.namespace, group.endpointId, group.modelId, members.map(({ customId }) => customId).sort()])).slice(0, 32);
    const submission: BatchSubmissionRecord = {
      schemaVersion: 1, id, key: `arbitra-${id}`, endpointId: group.endpointId, driverId: driver.id, capabilityStatus: driver.declaration.status,
      modelId: group.modelId, members: members.map(({ itemId, customId }) => ({ itemId, customId })), state: "prepared",
      providerJobId: null, providerStatus: null, pollIntervalMs: group.settings.pollIntervalMs, maximumWaitMs: group.settings.maximumWaitMs, preparedAt: this.#now(), sentAt: null,
      submittedAt: null, deadlineAt: null, lastPolledAt: null, endedAt: null, cancelRequestedAt: null, cancelReason: null,
      reconciliation: { attempts: 0, lastResult: null }, resolution: null, error: null, anomalies: [],
    };
    try {
      // A crash while `prepared` is provably unsent; `sending` is persisted before any byte leaves.
      await this.#serial(async () => {
        await this.#saveSubmission(submission);
        await this.#updateMembers(submission, (attempt) => ({ ...attempt, submissionId: id }));
        await this.#saveSubmission({ ...submission, state: "sending", sentAt: this.#now() });
      });
    } catch (error) { for (const member of members) member.reject(error); return; }
    let providerJobId: string;
    try {
      ({ providerJobId } = await this.#withTimeout((signal) => driver.submit({
        submissionKey: submission.key, modelId: group.modelId, items: members.map(({ customId, item }) => ({ customId, request: item.request })),
      }, signal)));
    } catch (error) {
      if (error instanceof BatchRequestError && error.accepted === "no") {
        await this.#serial(async () => {
          const current = await this.#submission(id);
          const failure = { code: error.code, message: error.message };
          await this.#updateMembers(current, (attempt) => ({ ...attempt, state: "not_submitted", error: failure }));
          await this.#saveSubmission({ ...current, state: "rejected", error: failure });
        });
        for (const member of members) member.reject(new BatchItemFailedError(`BATCH_SUBMISSION_REJECTED_${error.code}`, error.message, error.retryable));
        return;
      }
      await this.#serial(async () => {
        const current = await this.#submission(id);
        await this.#saveSubmission({ ...current, state: "uncertain", error: { code: error instanceof BatchRequestError ? error.code : "UNKNOWN", message: error instanceof Error ? error.message : String(error) } });
      });
      await this.#reconcileThenPoll(id);
      return;
    }
    await this.#serial(async () => this.#markSubmitted(await this.#submission(id), providerJobId, null));
    await this.#cancelIfAbandoned(id);
    this.#poll(id);
  }

  async #markSubmitted(submission: BatchSubmissionRecord, providerJobId: string, resolution: BatchSubmissionRecord["resolution"]): Promise<BatchSubmissionRecord> {
    const at = this.#now();
    await this.#updateMembers(submission, (attempt) => attempt.state === "queued" ? { ...attempt, state: "submitted" } : attempt);
    const next: BatchSubmissionRecord = { ...submission, state: "submitted", providerJobId, submittedAt: at, deadlineAt: at + submission.maximumWaitMs, resolution: resolution ?? submission.resolution };
    await this.#saveSubmission(next);
    return next;
  }

  async #reconcileSubmission(id: string): Promise<BatchSubmissionRecord> {
    const submission = await this.#submission(id);
    if (submission.state !== "sending" && submission.state !== "uncertain") return submission;
    const driver = this.options.driver(submission.endpointId);
    let lookup: Awaited<ReturnType<BatchDriver["find"]>>;
    try { lookup = await this.#withTimeout((signal) => driver.find(submission.key, submission.modelId, signal)); }
    catch (error) { lookup = { kind: "inconclusive", reason: error instanceof Error ? error.message : String(error) }; }
    return this.#serial(async () => {
      const current = await this.#submission(id);
      if (current.state !== "sending" && current.state !== "uncertain") return current;
      const reconciled = { ...current, reconciliation: { attempts: current.reconciliation.attempts + 1, lastResult: lookup.kind === "found" ? `found:${lookup.providerJobId}` : `${lookup.kind}${"reason" in lookup ? `:${lookup.reason}` : ""}` } };
      if (lookup.kind === "found") return this.#markSubmitted(reconciled, lookup.providerJobId, null);
      // Not found is not proof of absence (listings can lag). Only the operator may declare it unsent.
      const next: BatchSubmissionRecord = { ...reconciled, state: "uncertain" };
      await this.#saveSubmission(next);
      return next;
    });
  }

  async #reconcileThenPoll(id: string): Promise<void> {
    let submission: BatchSubmissionRecord;
    try { submission = await this.#reconcileSubmission(id); }
    catch (error) { this.#rejectAll(error); return; }
    if (submission.state === "submitted") { await this.#cancelIfAbandoned(id); this.#poll(id); return; }
    const reason = submission.reconciliation.lastResult ?? submission.error?.message ?? "acknowledgment lost";
    this.#rejectMembers(submission, new BatchSubmissionUncertainError(id, submission.key, reason));
  }

  // ---- polling and results -----------------------------------------------------------------

  #poll(id: string): void {
    const existing = this.#pollers.get(id);
    if (existing !== undefined) {
      // The running loop may be exiting; re-check once it has, so a new waiter is never orphaned.
      void existing.then(() => { if (!this.#pollers.has(id)) this.#poll(id); });
      return;
    }
    const poller = this.#pollLoop(id).finally(() => { this.#pollers.delete(id); });
    this.#pollers.set(id, poller);
  }

  async #pollLoop(id: string): Promise<void> {
    let failures = 0;
    const maximumFailures = this.options.maximumPollFailures ?? 5;
    for (;;) {
      let submission: BatchSubmissionRecord;
      try { submission = await this.#submission(id); } catch (error) { this.#rejectAll(error); return; }
      if (!this.#hasWaiters(submission)) return;
      if (submission.state === "ended") { await this.#deliverMembers(submission); return; }
      if (submission.state !== "submitted") { this.#rejectMembers(submission, new Error(`BATCH_STATE_INCONSISTENT:${id}:${submission.state}`)); return; }
      try {
        submission = await this.#pollOnce(id);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= maximumFailures) {
          this.#rejectMembers(submission, new BatchItemFailedError("BATCH_POLL_FAILED", `${error instanceof Error ? error.message : String(error)}; the job is retained and resumes on restart`, true));
          return;
        }
      }
      if (submission.state === "ended") { await this.#deliverMembers(submission); return; }
      // Checked after a poll, so a resumed wait past its deadline still collects a finished job.
      if (submission.deadlineAt !== null && this.#now() >= submission.deadlineAt) {
        await this.#requestCancel(id, "deadline");
        this.#rejectMembers(submission, new BatchItemFailedError("BATCH_DEADLINE_EXCEEDED", `No result within the configured maximum wait; cancellation requested for ${submission.providerJobId ?? id}. Late results are collected on reconcile.`, true));
        return;
      }
      try { await this.#timer.sleep(submission.pollIntervalMs); }
      catch (error) { this.#rejectMembers(submission, error); return; }
    }
  }

  /** One status check; collects results when the provider reports the job ended. */
  async #pollOnce(id: string): Promise<BatchSubmissionRecord> {
    const submission = await this.#submission(id);
    if (submission.state !== "submitted" || submission.providerJobId === null) return submission;
    const jobId = submission.providerJobId;
    const driver = this.options.driver(submission.endpointId);
    const status = await this.#withTimeout((signal) => driver.status(jobId, signal));
    if (!status.ended) {
      return this.#serial(async () => {
        const next = { ...(await this.#submission(id)), providerStatus: status.providerStatus, lastPolledAt: this.#now() };
        await this.#saveSubmission(next);
        return next;
      });
    }
    const results = await this.#withTimeout((signal) => driver.results(jobId, signal));
    return this.#serial(() => this.#collect(id, driver, status, results));
  }

  async #collect(id: string, driver: BatchDriver, status: BatchJobStatus, results: readonly BatchRawItemResult[]): Promise<BatchSubmissionRecord> {
    const submission = await this.#submission(id);
    if (submission.state === "ended") return submission;
    const members = new Set(submission.members.map(({ customId }) => customId));
    const byCustomId = new Map<string, BatchRawItemResult>();
    const anomalies: string[] = [];
    for (const result of results) {
      if (!members.has(result.customId)) anomalies.push(`unmatched:${result.customId}`);
      else if (byCustomId.has(result.customId)) anomalies.push(`duplicate:${result.customId}`);
      else byCustomId.set(result.customId, result);
    }
    for (const member of submission.members) {
      const record = await this.#item(member.itemId);
      if (record === null) throw new Error(`BATCH_ITEM_STATE_LOST:${member.itemId}`);
      const attempts = [];
      for (const attempt of record.attempts) {
        if (attempt.customId !== member.customId || !["queued", "submitted"].includes(attempt.state)) { attempts.push(attempt); continue; }
        const result = byCustomId.get(member.customId);
        const usage = result?.outcome === "succeeded" ? driver.usage(result.body) : null;
        if (usage !== null && attempt.reservationId !== null) await this.options.budget.recordActual(record.activityId, usage, attempt.reservationId);
        const error = result?.error ?? (result === undefined ? status.jobFailure ?? { code: "BATCH_RESULT_MISSING", message: "No result line for this item" } : null);
        const state: AttemptState = result?.outcome ?? (status.jobFailure === null ? "missing" : "errored");
        attempts.push({ ...attempt, state, body: result?.outcome === "succeeded" ? result.body : null, error, usage,
          late: attempt.cancelRequested && state === "succeeded" });
      }
      await this.#saveItem({ ...record, attempts });
    }
    const next: BatchSubmissionRecord = { ...submission, state: "ended", providerStatus: status.providerStatus, lastPolledAt: this.#now(), endedAt: this.#now(), anomalies: [...submission.anomalies, ...anomalies] };
    await this.#saveSubmission(next);
    return next;
  }

  async #deliverMembers(submission: BatchSubmissionRecord): Promise<void> {
    for (const member of submission.members) {
      const waiter = this.#waiters.get(member.customId);
      if (waiter === undefined) continue;
      try {
        const record = await this.#item(member.itemId);
        const attempt = record?.attempts.find(({ customId }) => customId === member.customId);
        if (attempt === undefined) throw new Error(`BATCH_ITEM_STATE_LOST:${member.itemId}`);
        waiter.resolve(await this.#resultOf(waiter.item, member.itemId, attempt));
      } catch (error) { waiter.reject(error); }
    }
  }

  async #resultOf(item: BatchLaneItem, itemId: string, attempt: BatchAttemptRecord): Promise<BatchLaneResult> {
    const submission = attempt.submissionId === null ? null : await this.#submission(attempt.submissionId);
    const driver = this.options.driver(item.endpointId);
    const trace = (outcome: "completed" | "failed", errorCode: string | null) => this.options.traces?.record({
      activityId: item.activityId, providerId: item.providerId, modelId: item.modelId, transportId: item.endpointId,
      attempt: attempt.attempt, outcome, errorCode, usage: attempt.usage,
    });
    if (attempt.state !== "succeeded") {
      const code = attempt.state === "cancelled" ? "BATCH_ITEM_CANCELLED" : attempt.state === "expired" ? "BATCH_ITEM_EXPIRED"
        : attempt.state === "missing" ? "BATCH_RESULT_MISSING" : attempt.error?.code ?? "BATCH_ITEM_ERRORED";
      trace("failed", code);
      throw new BatchItemFailedError(code, attempt.error?.message ?? `Batch item ${attempt.state}`, attempt.state === "cancelled" || attempt.state === "expired");
    }
    let response: TransportResponse;
    try { response = driver.parse(attempt.body, item.request); }
    catch (error) { trace("failed", "MALFORMED_RESPONSE"); throw new BatchItemFailedError("MALFORMED_RESPONSE", error instanceof Error ? error.message : "Malformed batch result", false); }
    trace("completed", null);
    return Object.freeze({ response, provenance: Object.freeze({
      lane: "batch" as const, driverId: driver.id, capability: driver.declaration, itemId, traceId: item.traceId, customId: attempt.customId,
      attempt: attempt.attempt, submissionId: submission?.id ?? "", submissionKey: submission?.key ?? "", providerJobId: submission?.providerJobId ?? null, late: attempt.late,
    }) });
  }

  // ---- cancellation ------------------------------------------------------------------------

  async #cancelItem(customId: string): Promise<void> {
    const waiter = this.#waiters.get(customId);
    if (waiter === undefined) return;
    this.#waiters.delete(customId);
    waiter.reject(new BatchItemCancelledError(customId));
    let submissionId: string | null = null;
    try {
      await this.#serial(async () => {
        const record = await this.#item(waiter.itemId);
        if (record === null) return;
        const unsent = [...this.#groups.values()].some((group) => group.customIds.includes(customId));
        for (const group of this.#groups.values()) { const index = group.customIds.indexOf(customId); if (index >= 0) group.customIds.splice(index, 1); }
        await this.#saveItem({ ...record, attempts: record.attempts.map((attempt) => {
          if (attempt.customId !== customId) return attempt;
          submissionId = attempt.submissionId;
          return unsent && attempt.submissionId === null ? { ...attempt, cancelRequested: true, state: "not_submitted" as const } : { ...attempt, cancelRequested: true };
        }) });
      });
      if (submissionId !== null) await this.#cancelIfAbandoned(submissionId);
    } catch { /* cancellation is best effort; the item record remains the source of truth */ }
  }

  /** Cancels the provider job once every unfinished member has asked to cancel. */
  async #cancelIfAbandoned(id: string): Promise<void> {
    const submission = await this.#submission(id);
    if (submission.state !== "submitted" || submission.cancelRequestedAt !== null) return;
    for (const member of submission.members) {
      const attempt = (await this.#item(member.itemId))?.attempts.find(({ customId }) => customId === member.customId);
      if (attempt !== undefined && !attempt.cancelRequested && ["queued", "submitted"].includes(attempt.state)) return;
    }
    await this.#requestCancel(id, "all_items_cancelled");
  }

  async #requestCancel(id: string, reason: "deadline" | "all_items_cancelled"): Promise<void> {
    const submission = await this.#serial(async () => {
      const current = await this.#submission(id);
      if (current.cancelRequestedAt !== null || current.state !== "submitted") return null;
      const next = { ...current, cancelRequestedAt: this.#now(), cancelReason: reason };
      await this.#saveSubmission(next);
      return next;
    });
    if (submission?.providerJobId == null) return;
    const jobId = submission.providerJobId;
    try { await this.#withTimeout((signal) => this.options.driver(submission.endpointId).cancel(jobId, signal)); }
    catch (error) {
      await this.#serial(async () => {
        const current = await this.#submission(id);
        await this.#saveSubmission({ ...current, error: { code: "BATCH_CANCEL_FAILED", message: error instanceof Error ? error.message : String(error) } });
      });
    }
  }

  // ---- helpers -----------------------------------------------------------------------------

  async #abandonUnsent(id: string): Promise<BatchSubmissionRecord> {
    const submission = await this.#submission(id);
    if (submission.state !== "prepared") return submission;
    await this.#updateMembers(submission, (attempt) => attempt.state === "queued" ? { ...attempt, submissionId: null } : attempt);
    const next: BatchSubmissionRecord = { ...submission, state: "abandoned", error: { code: "NEVER_SENT", message: "Interrupted before the submission request was sent" } };
    await this.#saveSubmission(next);
    return next;
  }

  async #updateMembers(submission: BatchSubmissionRecord, update: (attempt: BatchAttemptRecord) => BatchAttemptRecord): Promise<void> {
    for (const member of submission.members) {
      const record = await this.#item(member.itemId);
      if (record === null) throw new Error(`BATCH_ITEM_STATE_LOST:${member.itemId}`);
      await this.#saveItem({ ...record, attempts: record.attempts.map((attempt) => attempt.customId === member.customId ? update(attempt) : attempt) });
    }
  }

  #hasWaiters(submission: BatchSubmissionRecord): boolean { return submission.members.some(({ customId }) => this.#waiters.has(customId)); }
  #rejectMembers(submission: BatchSubmissionRecord, error: unknown): void {
    for (const member of submission.members) this.#waiters.get(member.customId)?.reject(error);
  }
  /** Durable state could not be read; no waiter can be answered truthfully. */
  #rejectAll(error: unknown): void {
    for (const waiter of this.#waiters.values()) waiter.reject(error);
  }

  async #withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let rejectTimeout: (error: Error) => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const cancel = this.#timer.timeout(this.options.requestTimeoutMs, () => {
      controller.abort("timeout");
      rejectTimeout(new BatchRequestError("TIMEOUT", `Batch API request timed out after ${this.options.requestTimeoutMs}ms`, "unknown", true));
    });
    try { return await Promise.race([operation(controller.signal), timeout]); }
    finally { cancel(); }
  }

  async #item(itemId: string): Promise<BatchItemRecord | null> {
    const value = await this.options.backend.load(`item/${itemId}`);
    if (value === null || value === undefined) return null;
    return parseItem(value, itemId);
  }
  async #submission(id: string): Promise<BatchSubmissionRecord> {
    const value = await this.options.backend.load(`submission/${id}`);
    if (value === null || value === undefined) throw new Error(`BATCH_SUBMISSION_ABSENT:${id}`);
    return parseSubmission(value, id);
  }
  async #saveItem(record: BatchItemRecord): Promise<void> { await this.options.backend.save(`item/${record.itemId}`, record); }
  async #saveSubmission(record: BatchSubmissionRecord): Promise<void> { await this.options.backend.save(`submission/${record.id}`, record); }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#writes.then(operation);
    this.#writes = pending.catch(() => undefined);
    return pending;
  }
}

const LaneIds = { custom: (attempt: number, itemId: string): string => `a${attempt}-${itemId}` };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function validateItem(item: BatchLaneItem): void {
  for (const [name, value] of [["ACTIVITY", item.activityId], ["TRACE", item.traceId], ["ENDPOINT", item.endpointId], ["MODEL", item.modelId], ["FINGERPRINT", item.fingerprint]] as const) {
    if (value.trim() === "") throw new Error(`INVALID_BATCH_${name}_ID`);
  }
  if (item.request.modelId !== item.modelId) throw new Error("INVOCATION_MODEL_MISMATCH");
  if ((item.request.tools?.length ?? 0) > 0) throw new Error("BATCH_LANE_REQUIRES_SINGLE_SHOT_REQUEST");
  if (item.request.continuation !== undefined) throw new Error("BATCH_LANE_CONTINUATION_UNSUPPORTED");
  if (!Number.isSafeInteger(item.estimatedTokens) || item.estimatedTokens < item.request.maximumOutputTokens) throw new Error("OUTPUT_RESERVE_MISSING_FROM_ESTIMATE");
  const settings = item.settings;
  for (const value of [settings.pollIntervalMs, settings.maximumWaitMs, settings.maximumItemsPerSubmission, settings.maximumAttempts]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("INVALID_BATCH_LANE_SETTINGS");
  }
  if (!Number.isSafeInteger(settings.collectWindowMs) || settings.collectWindowMs < 0) throw new Error("INVALID_BATCH_LANE_SETTINGS");
}

function parseItem(value: unknown, itemId: string): BatchItemRecord {
  const record = value as BatchItemRecord;
  if (typeof value !== "object" || record.schemaVersion !== 1 || record.itemId !== itemId || !Array.isArray(record.attempts)
    || record.attempts.some((attempt, index) => attempt.attempt !== index + 1 || typeof attempt.customId !== "string")) {
    throw new Error(`INVALID_BATCH_ITEM_STATE:${itemId}`);
  }
  return record;
}
function parseSubmission(value: unknown, id: string): BatchSubmissionRecord {
  const record = value as BatchSubmissionRecord;
  if (typeof value !== "object" || record.schemaVersion !== 1 || record.id !== id || !Array.isArray(record.members) || typeof record.state !== "string") {
    throw new Error(`INVALID_BATCH_SUBMISSION_STATE:${id}`);
  }
  return record;
}
