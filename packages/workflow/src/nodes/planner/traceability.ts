export interface TraceabilityDiagnostic { readonly code: "TASK_REQUIRES_VALIDATION_ASSERTION" | "UNKNOWN_TASK_VALIDATION_ASSERTION" | "ACCEPTED_ISSUE_REQUIRES_VALIDATION_ASSERTION" | "ACCEPTED_ISSUE_SET_MISMATCH" | "UNKNOWN_ISSUE_VALIDATION_ASSERTION" | "FEATURE_REQUIREMENT_LINK_INVALID" | "ROUTING_RECOMMENDATION_MISSING" | "HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED"; readonly path: string; readonly message: string }
export interface TraceablePlan {
  readonly mode: "audit" | "feature" | "testing"; readonly acceptedIssueIds: readonly string[];
  readonly unresolvedQuestions: readonly { readonly id: string; readonly blocking: boolean; readonly blastRadius: "low" | "medium" | "high" }[];
  readonly validationContract: { readonly validation: readonly { readonly id: string }[] };
  readonly tasks: readonly { readonly id: string; readonly addresses: { readonly issues: readonly string[]; readonly validation: readonly string[]; readonly requirements: readonly string[] }; readonly context: readonly string[]; readonly routing: { readonly capability: string; readonly effort: string; readonly reason: readonly string[] } }[];
  readonly traceability: { readonly issueToValidation: readonly { readonly issueId: string; readonly validationIds: readonly string[] }[]; readonly requirementLinks: { readonly schemaVersion: number; readonly links: readonly { readonly requirementId: string; readonly validationIds: readonly string[]; readonly taskIds: readonly string[] }[] } };
  readonly routingRecommendations: readonly { readonly taskId: string }[];
}

export function validateTraceability(plan: TraceablePlan, expectedAcceptedIssueIds: readonly string[] = plan.acceptedIssueIds): readonly TraceabilityDiagnostic[] {
  const diagnostics: TraceabilityDiagnostic[] = []; const validationIds = new Set(plan.validationContract.validation.map(({ id }) => id)); const taskIds = new Set(plan.tasks.map(({ id }) => id)); const accepted = new Set(expectedAcceptedIssueIds);
  if ([...accepted].some((id) => !plan.acceptedIssueIds.includes(id)) || plan.acceptedIssueIds.some((id) => !accepted.has(id))) diagnostics.push(diagnostic("ACCEPTED_ISSUE_SET_MISMATCH", "acceptedIssueIds", "Plan acceptedIssueIds must exactly match accepted canonical issue input."));
  for (const [index, task] of plan.tasks.entries()) {
    if (task.addresses.validation.length === 0) diagnostics.push(diagnostic("TASK_REQUIRES_VALIDATION_ASSERTION", `tasks[${index}].addresses.validation`, `Task ${task.id} must map to at least one validation assertion.`));
    for (const id of task.addresses.validation) if (!validationIds.has(id)) diagnostics.push(diagnostic("UNKNOWN_TASK_VALIDATION_ASSERTION", `tasks[${index}].addresses.validation`, `Task ${task.id} references unknown validation assertion ${id}.`));
    if (!plan.routingRecommendations.some(({ taskId }) => taskId === task.id) || task.routing.reason.length === 0) diagnostics.push(diagnostic("ROUTING_RECOMMENDATION_MISSING", `tasks[${index}].routing`, `Task ${task.id} requires capability, effort and a routing reason.`));
    const blockingHigh = plan.unresolvedQuestions.filter(({ blocking, blastRadius }) => blocking && blastRadius === "high"); for (const question of blockingHigh) if (task.context.includes(`resolves:${question.id}`)) diagnostics.push(diagnostic("HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED", `tasks[${index}].context`, `Task ${task.id} silently resolves ${question.id}.`));
  }
  const mappings = new Map(plan.traceability.issueToValidation.map(({ issueId, validationIds: ids }) => [issueId, ids]));
  for (const issueId of accepted) { const ids = mappings.get(issueId) ?? []; if (ids.length === 0) diagnostics.push(diagnostic("ACCEPTED_ISSUE_REQUIRES_VALIDATION_ASSERTION", "traceability.issueToValidation", `Accepted issue ${issueId} must map to a validation assertion.`)); for (const id of ids) if (!validationIds.has(id)) diagnostics.push(diagnostic("UNKNOWN_ISSUE_VALIDATION_ASSERTION", "traceability.issueToValidation", `Issue ${issueId} references unknown validation assertion ${id}.`)); }
  if (plan.mode === "feature") for (const [index, link] of plan.traceability.requirementLinks.links.entries()) { if (link.validationIds.some((id) => !validationIds.has(id)) || link.taskIds.some((id) => !taskIds.has(id))) diagnostics.push(diagnostic("FEATURE_REQUIREMENT_LINK_INVALID", `traceability.requirementLinks.links[${index}]`, `Requirement ${link.requirementId} must retain valid task and validation links.`)); }
  return Object.freeze(diagnostics);
}
function diagnostic(code: TraceabilityDiagnostic["code"], path: string, message: string): TraceabilityDiagnostic { return Object.freeze({ code, path, message }); }
