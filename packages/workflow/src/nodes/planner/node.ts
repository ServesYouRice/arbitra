import { validateTraceability, type TraceablePlan, type TraceabilityDiagnostic } from "./traceability.js";

export interface PlannerCanonicalIssue { readonly candidateId: string; readonly disposition: string; readonly claim: { readonly trust: "untrusted_data"; readonly title: string; readonly description: string }; readonly sourceFindingIds: readonly string[] }
export interface PlannerInput { readonly projectContext: unknown; readonly canonicalIssues: readonly PlannerCanonicalIssue[]; readonly repositoryContext: readonly { readonly ref: string; readonly trust: "repo" | "derived"; readonly content: string }[]; readonly constraints: readonly string[]; readonly workflowGoal: string; readonly premiseReport: { readonly status: "positive" | "null" | "negative" | "unavailable"; readonly interpretation: "smoke_test_only_not_proof"; readonly limitations: readonly string[] } }
export interface PlannerRequest { readonly session: "single_coherent_planner"; readonly input: PlannerInput; readonly protocol: { readonly protocolId: "planner"; readonly protocolVersion: string; readonly protocolHash: string }; readonly outputSchema: "PlanIR"; readonly forbiddenInputs: readonly ["raw_audit_transcripts"] }
export interface PlannerRuntime { plan(request: PlannerRequest): Promise<unknown>; readonly logicalModelCalls?: number }
export interface PlannerSchema<TPlan extends TraceablePlan> { parse(value: unknown): TPlan }
export interface PlannerNodeConfig<TPlan extends TraceablePlan> { readonly protocolVersion: string; readonly protocolHash: string; readonly runtime: PlannerRuntime; readonly schema: PlannerSchema<TPlan> }
export interface PlannerNode<TPlan extends TraceablePlan> { run(input: PlannerInput): Promise<{ readonly plan: TPlan; readonly diagnostics: readonly TraceabilityDiagnostic[]; readonly modelCalls: number }> }

export function plannerNode<TPlan extends TraceablePlan>(config: PlannerNodeConfig<TPlan>): PlannerNode<TPlan> {
  if (!/^[a-f0-9]{64}$/u.test(config.protocolHash) || config.protocolVersion.trim() === "") throw new Error("PLANNER_PROTOCOL_NOT_PINNED");
  return Object.freeze({ async run(input: PlannerInput) {
    validateInput(input); const protocol = Object.freeze({ protocolId: "planner" as const, protocolVersion: config.protocolVersion, protocolHash: config.protocolHash });
    const raw = await config.runtime.plan(Object.freeze({ session: "single_coherent_planner" as const, input: freezeInput(input), protocol, outputSchema: "PlanIR" as const, forbiddenInputs: Object.freeze(["raw_audit_transcripts"] as const) }));
    const plan = config.schema.parse(withoutSelfReferences(raw)); const accepted = input.canonicalIssues.filter(({ disposition }) => disposition === "accepted").map(({ candidateId }) => candidateId).sort(); const diagnostics = validateTraceability(plan, accepted);
    if (diagnostics.length > 0) throw new PlannerTraceabilityError(diagnostics);
    // Logical planner requests can each contain tool turns or reuse durable output;
    // provider attempts and spend remain authoritative in the activity trace log.
    const modelCalls = config.runtime.logicalModelCalls ?? 1;
    if (!Number.isSafeInteger(modelCalls) || modelCalls < 1) throw new Error("INVALID_PLANNER_MODEL_CALL_COUNT");
    return Object.freeze({ plan, diagnostics, modelCalls });
  } });
}
export class PlannerTraceabilityError extends Error { constructor(readonly diagnostics: readonly TraceabilityDiagnostic[]) { super(diagnostics.map(({ code, message }) => `${code}: ${message}`).join("\n")); this.name = "PlannerTraceabilityError"; } }
function validateInput(input: PlannerInput): void { if (input.workflowGoal.trim() === "" || input.premiseReport.limitations.length === 0) throw new Error("INVALID_PLANNER_INPUT"); if (containsTranscriptKey(input)) throw new Error("RAW_AUDIT_TRANSCRIPT_FORBIDDEN"); for (const issue of input.canonicalIssues) if (issue.claim.trust !== "untrusted_data" || issue.sourceFindingIds.length === 0) throw new Error(`INVALID_PLANNER_CANONICAL_ISSUE:${issue.candidateId}`); }
function containsTranscriptKey(value: unknown): boolean { if (Array.isArray(value)) return value.some(containsTranscriptKey); if (typeof value !== "object" || value === null) return false; return Object.entries(value).some(([key, child]) => /(?:raw)?(?:audit)?transcript/iu.test(key) || containsTranscriptKey(child)); }
function freezeInput(input: PlannerInput): PlannerInput { return Object.freeze({ ...input, canonicalIssues: Object.freeze([...input.canonicalIssues]), repositoryContext: Object.freeze([...input.repositoryContext]), constraints: Object.freeze([...input.constraints]), premiseReport: Object.freeze({ ...input.premiseReport, limitations: Object.freeze([...input.premiseReport.limitations]) }) }); }
/**
 * A task that depends on, blocks or conflicts with itself states nothing, yet real models
 * emit exactly that for single-task plans (observed live: a `TASK-1 -> TASK-1` edge on
 * every Gemini flash-lite plan). Removing such self-references cannot widen scope or drop
 * a real ordering; every other graph defect is still reported by traceability validation.
 */
export function withoutSelfReferences(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const plan = raw as Record<string, unknown>;
  const graph = Array.isArray(plan["taskGraph"]) ? plan["taskGraph"].filter((edge: unknown) => !(edge !== null && typeof edge === "object" && (edge as { from?: unknown }).from === (edge as { to?: unknown }).to)) : plan["taskGraph"];
  const tasks = Array.isArray(plan["tasks"]) ? plan["tasks"].map((task: unknown) => {
    if (task === null || typeof task !== "object") return task;
    const { id, dependencies } = task as { id?: unknown; dependencies?: unknown };
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) return task;
    return { ...task, dependencies: Object.fromEntries(Object.entries(dependencies).map(([key, value]) => [key, Array.isArray(value) ? value.filter((other) => other !== id) : value])) };
  }) : plan["tasks"];
  return { ...plan, ...(plan["taskGraph"] === undefined ? {} : { taskGraph: graph }), ...(plan["tasks"] === undefined ? {} : { tasks }) };
}

