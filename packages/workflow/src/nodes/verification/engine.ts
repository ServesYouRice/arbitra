import { runDeterministicLadder, type VerificationAttempt, type VerificationItem, type VerificationMethod, type VerificationOutcome, type VerificationTools } from "./ladder.js";

export const VERIFICATION_SUBGRAPH_NODE = Object.freeze({ kind: "subgraph" as const, purpose: "verification" as const });
export interface VerificationObjection { readonly citesLocation: boolean; readonly evidenceType: "repository" | "test" | "specification" | "inference" | "speculation"; readonly resolvedBy: string | null }
export interface VerificationIssue { readonly severity: VerificationItem["severity"]; readonly objections: readonly VerificationObjection[] }
export interface ModelVerificationRequest { readonly candidateId: string; readonly question: string; readonly context: { readonly claim: string; readonly citedContext: VerificationItem["citedContext"]; readonly deterministicAttempts: readonly { readonly method: VerificationAttempt["method"]; readonly artifactRefs: readonly string[]; readonly evidenceIds: readonly string[] }[] } }
export interface ModelVerificationResponse { readonly outcome: VerificationOutcome; readonly evidenceIds: readonly string[]; readonly artifactRefs: readonly string[]; readonly activityId: string; readonly confidence: number }
export interface VerificationModel {
  verify(request: ModelVerificationRequest): Promise<ModelVerificationResponse>;
  /** False when the question cannot be put to the model at all, because what it must carry exceeds the model's
   * context. The item then stays unverified and spends none of the run's model questions. */
  fits?(request: ModelVerificationRequest): Promise<boolean>;
  /**
   * The questions that may share one call, as groups in question order. A group of more than one question is put
   * with `verifyGroup`, which answers in the group's order. Without both every question is asked alone.
   */
  group?(requests: readonly ModelVerificationRequest[]): Promise<readonly (readonly ModelVerificationRequest[])[]>;
  verifyGroup?(requests: readonly ModelVerificationRequest[]): Promise<readonly ModelVerificationResponse[]>;
}
export interface VerificationIssueOperation { readonly operationId: string; readonly candidateId: string; readonly authorId: "verification"; readonly round: number; readonly type: "accept" | "reject" | "needs_verification"; readonly citedEvidenceIds: readonly string[]; readonly reason: string; readonly verification: { readonly result: VerificationOutcome; readonly method: VerificationMethod; readonly evidenceIds: readonly string[]; readonly artifactRefs: readonly string[]; readonly toolCallIds: readonly string[]; readonly activityId: string; readonly confidence: number | null } }
export interface VerificationOperationSink { append(operation: VerificationIssueOperation): Promise<void> }
export interface VerificationResult { readonly candidateId: string; readonly outcome: VerificationOutcome; readonly method: VerificationMethod; readonly operation: VerificationIssueOperation; readonly attempts: readonly VerificationAttempt[]; readonly modelCalls: 0 | 1; readonly contextLimited: boolean }
export interface VerificationRunMetrics { readonly itemCount: number; readonly resolvedDisputes: number; readonly modelCalls: number; readonly modelQuestionCalls: number; readonly deferredItemIds: readonly string[]; readonly contextLimitedItemIds: readonly string[]; readonly rungDistribution: Readonly<Record<VerificationMethod, number>> }

export function escalateToVerification(issue: VerificationIssue): boolean { return (issue.severity === "critical" || issue.severity === "high") && issue.objections.some((objection) => objection.citesLocation && objection.evidenceType !== "speculation" && objection.resolvedBy === null); }

interface PreparedItem { readonly item: VerificationItem; readonly ladder: Awaited<ReturnType<typeof runDeterministicLadder>>; readonly request: ModelVerificationRequest | null; readonly contextLimited: boolean }

/** The deterministic rungs of one item, and the model question it is asked when they settle nothing. */
async function prepareItem(item: VerificationItem, tools: VerificationTools, allowModelCall: boolean, model: VerificationModel | undefined): Promise<PreparedItem> {
  if (item.citedEvidenceIds.length === 0 || item.question.trim() === "" || item.question.includes("\n")) throw new Error("INVALID_VERIFICATION_ITEM");
  const ladder = await runDeterministicLadder(item, tools);
  const request: ModelVerificationRequest | null = ladder.resolved !== null || !allowModelCall || model === undefined ? null
    : Object.freeze({ candidateId: item.candidateId, question: item.question, context: Object.freeze({ claim: item.claim, citedContext: item.citedContext, deterministicAttempts: Object.freeze(ladder.attempts.map(({ method: attemptedMethod, artifactRefs: refs, evidenceIds: ids }) => Object.freeze({ method: attemptedMethod, artifactRefs: refs, evidenceIds: ids }))) }) });
  const contextLimited = request !== null && await model?.fits?.(request) === false;
  return { item, ladder, request, contextLimited };
}

/** Records one prepared item's outcome: the rung that settled it, the model's answer, or neither. */
async function settleItem(prepared: PreparedItem, response: ModelVerificationResponse | null, dependencies: { readonly sink: VerificationOperationSink; readonly round: number }): Promise<VerificationResult> {
  const { item, ladder, contextLimited } = prepared;
  let outcome: VerificationOutcome; let method: VerificationMethod; let evidenceIds: readonly string[]; let artifactRefs: readonly string[]; let toolCallIds: readonly string[]; let activityId: string; let confidence: number | null; let modelCalls: 0 | 1 = 0;
  if (ladder.resolved !== null) { outcome = ladder.resolved.verdict === "confirmed" ? "CONFIRMED" : "REJECTED"; method = ladder.resolved.method; evidenceIds = ladder.resolved.evidenceIds; artifactRefs = ladder.resolved.artifactRefs; toolCallIds = ladder.resolved.toolCallIds; activityId = ladder.resolved.activityId; confidence = ladder.resolved.confidence; }
  else if (response !== null) {
    validateModelResponse(response); outcome = response.outcome; method = "single_model_question"; evidenceIds = response.evidenceIds; artifactRefs = response.artifactRefs; toolCallIds = Object.freeze([]); activityId = response.activityId; confidence = response.confidence; modelCalls = 1;
  } else { outcome = "STILL_NEEDS_VERIFICATION"; method = ladder.attempts.at(-1)?.method ?? "bounded_deterministic_check"; evidenceIds = item.citedEvidenceIds; artifactRefs = Object.freeze(ladder.attempts.flatMap(({ artifactRefs: refs }) => refs)); toolCallIds = Object.freeze(ladder.attempts.flatMap(({ toolCallIds: ids }) => ids)); activityId = ladder.attempts.at(-1)?.activityId ?? `verification:${item.candidateId}`; confidence = null; }
  const operation = operationFor(item, dependencies.round, outcome, method, evidenceIds.length === 0 ? item.citedEvidenceIds : evidenceIds, artifactRefs, toolCallIds, activityId, confidence); await dependencies.sink.append(operation);
  return Object.freeze({ candidateId: item.candidateId, outcome, method, operation, attempts: ladder.attempts, modelCalls, contextLimited });
}

export async function verifyItem(item: VerificationItem, tools: VerificationTools, budget: { readonly allowModelCall: boolean }, dependencies: { readonly model?: VerificationModel; readonly sink: VerificationOperationSink; readonly round: number }): Promise<VerificationResult> {
  const prepared = await prepareItem(item, tools, budget.allowModelCall, dependencies.model);
  const response = prepared.request !== null && !prepared.contextLimited && dependencies.model !== undefined ? await dependencies.model.verify(prepared.request) : null;
  return settleItem(prepared, response, dependencies);
}

/** Runs independent work and returns the results in the order of the items. The default takes one item at a time. */
export type VerificationTogether = <T, R>(items: readonly T[], run: (item: T) => Promise<R>) => Promise<R[]>;

export async function verifyItems(items: readonly VerificationItem[], tools: VerificationTools, config: { readonly maximumItems: number; readonly allowModelCall: boolean; readonly maximumModelCalls?: number; readonly round: number }, dependencies: { readonly model?: VerificationModel; readonly sink: VerificationOperationSink; readonly together?: VerificationTogether }): Promise<{ readonly results: readonly VerificationResult[]; readonly metrics: VerificationRunMetrics }> {
  if (!Number.isSafeInteger(config.maximumItems) || config.maximumItems < 0) throw new Error("INVALID_VERIFICATION_ITEM_BUDGET"); const selected = items.slice(0, config.maximumItems); const deferred = items.slice(config.maximumItems).map(({ candidateId }) => candidateId);
  const maximumModelCalls = config.maximumModelCalls ?? config.maximumItems;
  if (!Number.isSafeInteger(maximumModelCalls) || maximumModelCalls < 0) throw new Error("INVALID_VERIFICATION_MODEL_BUDGET");
  // The rungs of every item run first, in item order, and the model questions go to the first items that need
  // one. No question reads another's answer, so they may be asked side by side (`together`); the outcomes are
  // recorded in item order. Observed live (P20 pilot): fifty items one after another, each waiting for the last.
  const prepared: PreparedItem[] = []; let assigned = 0;
  for (const item of selected) {
    const entry = await prepareItem(item, tools, config.allowModelCall && assigned < maximumModelCalls, dependencies.model);
    if (entry.request !== null && !entry.contextLimited) assigned += 1;
    prepared.push(entry);
  }
  const model = dependencies.model;
  const together: VerificationTogether = dependencies.together ?? (async (list, run) => { const out = []; for (const entry of list) out.push(await run(entry)); return out; });
  const asked = prepared.flatMap(({ request, contextLimited }) => request !== null && !contextLimited && model !== undefined ? [request] : []);
  const groups = model?.group !== undefined && model.verifyGroup !== undefined ? await model.group(asked) : asked.map((request) => [request]);
  const grouped = groups.flatMap((group) => group.map(({ candidateId }) => candidateId));
  // Every question in exactly one group; the outcomes are still recorded in item order.
  if (grouped.length !== asked.length || new Set(grouped).size !== grouped.length || asked.some(({ candidateId }) => !grouped.includes(candidateId))) throw new Error("VERIFICATION_GROUPS_INVALID");
  const answers = await together(groups, async (group) => {
    const [only] = group;
    if (model === undefined || only === undefined) return [];
    const replies = group.length === 1 || model.verifyGroup === undefined ? [await model.verify(only)] : await model.verifyGroup(group);
    if (replies.length !== group.length) throw new Error("VERIFICATION_GROUP_ANSWER_COUNT");
    return replies;
  });
  const responses = new Map(groups.flatMap((group, index) => group.map(({ candidateId }, position) => [candidateId, answers[index]?.[position] ?? null] as const)));
  const results: VerificationResult[] = [];
  for (const entry of prepared) results.push(await settleItem(entry, responses.get(entry.item.candidateId) ?? null, { sink: dependencies.sink, round: config.round }));
  const distribution = Object.fromEntries((["cited_lines", "symbol_or_call_path", "route_config_middleware", "dependency_or_import_path", "allowlisted_safe_test", "bounded_deterministic_check", "single_model_question"] as VerificationMethod[]).map((method) => [method, results.filter((result) => result.method === method).length])) as Record<VerificationMethod, number>;
  return Object.freeze({ results: Object.freeze(results), metrics: Object.freeze({ itemCount: results.length, resolvedDisputes: results.filter(({ outcome }) => outcome !== "STILL_NEEDS_VERIFICATION").length, modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0), modelQuestionCalls: groups.length, deferredItemIds: Object.freeze(deferred), contextLimitedItemIds: Object.freeze(results.filter(({ contextLimited }) => contextLimited).map(({ candidateId }) => candidateId)), rungDistribution: Object.freeze(distribution) }) });
}

function operationFor(item: VerificationItem, round: number, outcome: VerificationOutcome, method: VerificationMethod, evidenceIds: readonly string[], artifactRefs: readonly string[], toolCallIds: readonly string[], activityId: string, confidence: number | null): VerificationIssueOperation { const type = outcome === "CONFIRMED" ? "accept" : outcome === "REJECTED" ? "reject" : "needs_verification"; return Object.freeze({ operationId: `verification:${round}:${item.candidateId}`, candidateId: item.candidateId, authorId: "verification", round, type, citedEvidenceIds: Object.freeze([...evidenceIds]), reason: `Verification ${outcome.toLocaleLowerCase("en-US")} via ${method}.`, verification: Object.freeze({ result: outcome, method, evidenceIds: Object.freeze([...evidenceIds]), artifactRefs: Object.freeze([...artifactRefs]), toolCallIds: Object.freeze([...toolCallIds]), activityId, confidence }) }); }
function validateModelResponse(response: ModelVerificationResponse): void { if (!["CONFIRMED", "REJECTED", "STILL_NEEDS_VERIFICATION"].includes(response.outcome) || response.activityId.trim() === "" || !Number.isFinite(response.confidence) || response.confidence < 0 || response.confidence > 1) throw new Error("INVALID_MODEL_VERIFICATION_RESPONSE"); }
