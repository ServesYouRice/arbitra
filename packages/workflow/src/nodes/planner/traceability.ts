export interface TraceabilityDiagnostic { readonly code: "TASK_REQUIRES_VALIDATION_ASSERTION" | "UNKNOWN_TASK_VALIDATION_ASSERTION" | "ACCEPTED_ISSUE_REQUIRES_VALIDATION_ASSERTION" | "ACCEPTED_ISSUE_SET_MISMATCH" | "UNKNOWN_ISSUE_VALIDATION_ASSERTION" | "FEATURE_REQUIREMENT_LINK_INVALID" | "ROUTING_RECOMMENDATION_MISSING" | "HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED" | "DUPLICATE_PLAN_ID" | "UNKNOWN_TASK_ISSUE" | "ACCEPTED_ISSUE_REQUIRES_TASK" | "INVALID_TASK_GRAPH" | "TASK_GRAPH_CYCLE" | "INVALID_PLAN_REFERENCE" | "SHARED_WRITE_SCOPE_UNORDERED"; readonly path: string; readonly message: string }
export interface TraceablePlan {
  readonly mode: "audit" | "feature" | "testing"; readonly acceptedIssueIds: readonly string[];
  readonly unresolvedQuestions: readonly { readonly id: string; readonly blocking: boolean; readonly blastRadius: "low" | "medium" | "high" }[];
  readonly validationContract: { readonly validation: readonly { readonly id: string }[] };
  readonly tasks: readonly { readonly id: string; readonly addresses: { readonly issues: readonly string[]; readonly validation: readonly string[]; readonly requirements: readonly string[] }; readonly context: readonly string[]; readonly routing: { readonly capability: string; readonly effort: string; readonly reason: readonly string[] }; readonly dependencies?: { readonly dependsOn: readonly string[]; readonly blocks: readonly string[]; readonly conflictsWith: readonly string[] }; readonly scope?: { readonly likelyFiles: readonly string[] }; readonly filesNotToTouch?: readonly string[] }[];
  readonly taskGraph?: readonly { readonly from: string; readonly to: string }[];
  readonly traceability: { readonly issueToValidation: readonly { readonly issueId: string; readonly validationIds: readonly string[] }[]; readonly requirementLinks: { readonly schemaVersion: number; readonly links: readonly { readonly requirementId: string; readonly validationIds: readonly string[]; readonly taskIds: readonly string[] }[] } };
  readonly routingRecommendations: readonly { readonly taskId: string }[];
}

export function validateTraceability(plan: TraceablePlan, expectedAcceptedIssueIds: readonly string[] = plan.acceptedIssueIds): readonly TraceabilityDiagnostic[] {
  const diagnostics: TraceabilityDiagnostic[] = []; const validationIds = new Set(plan.validationContract.validation.map(({ id }) => id)); const taskIds = new Set(plan.tasks.map(({ id }) => id)); const accepted = new Set(expectedAcceptedIssueIds);
  for (const [path, ids] of [
    ["tasks", plan.tasks.map(({ id }) => id)], ["validationContract.validation", plan.validationContract.validation.map(({ id }) => id)],
    ["acceptedIssueIds", plan.acceptedIssueIds], ["unresolvedQuestions", plan.unresolvedQuestions.map(({ id }) => id)],
    ["traceability.issueToValidation", plan.traceability.issueToValidation.map(({ issueId }) => issueId)],
    ["routingRecommendations", plan.routingRecommendations.map(({ taskId }) => taskId)],
    ["traceability.requirementLinks", plan.traceability.requirementLinks.links.map(({ requirementId }) => requirementId)],
  ] as const) if (new Set(ids).size !== ids.length) diagnostics.push(diagnostic("DUPLICATE_PLAN_ID", path, "Identifiers must be unique within this collection."));
  for (const issueId of accepted) if (!plan.tasks.some(({ addresses }) => addresses.issues.includes(issueId))) diagnostics.push(diagnostic("ACCEPTED_ISSUE_REQUIRES_TASK", "tasks", `Accepted issue ${issueId} has no implementation task.`));
  for (const { issueId } of plan.traceability.issueToValidation) if (!accepted.has(issueId)) diagnostics.push(diagnostic("INVALID_PLAN_REFERENCE", "traceability.issueToValidation", `Unknown issue ${issueId}.`));
  for (const { taskId } of plan.routingRecommendations) if (!taskIds.has(taskId)) diagnostics.push(diagnostic("INVALID_PLAN_REFERENCE", "routingRecommendations", `Unknown task ${taskId}.`));
  if ([...accepted].some((id) => !plan.acceptedIssueIds.includes(id)) || plan.acceptedIssueIds.some((id) => !accepted.has(id))) diagnostics.push(diagnostic("ACCEPTED_ISSUE_SET_MISMATCH", "acceptedIssueIds", "Plan acceptedIssueIds must exactly match accepted canonical issue input."));
  for (const [index, task] of plan.tasks.entries()) {
    for (const issueId of task.addresses.issues) if (!accepted.has(issueId)) diagnostics.push(diagnostic("UNKNOWN_TASK_ISSUE", `tasks[${index}].addresses.issues`, `Task ${task.id} refers to unaccepted issue ${issueId}.`));
    if (task.addresses.validation.length === 0) diagnostics.push(diagnostic("TASK_REQUIRES_VALIDATION_ASSERTION", `tasks[${index}].addresses.validation`, `Task ${task.id} must map to at least one validation assertion.`));
    for (const id of task.addresses.validation) if (!validationIds.has(id)) diagnostics.push(diagnostic("UNKNOWN_TASK_VALIDATION_ASSERTION", `tasks[${index}].addresses.validation`, `Task ${task.id} references unknown validation assertion ${id}.`));
    if (!plan.routingRecommendations.some(({ taskId }) => taskId === task.id) || task.routing.reason.length === 0) diagnostics.push(diagnostic("ROUTING_RECOMMENDATION_MISSING", `tasks[${index}].routing`, `Task ${task.id} requires capability, effort and a routing reason.`));
    const blockingHigh = plan.unresolvedQuestions.filter(({ blocking, blastRadius }) => blocking && blastRadius === "high"); for (const question of blockingHigh) if (task.context.includes(`resolves:${question.id}`)) diagnostics.push(diagnostic("HIGH_BLAST_RADIUS_QUESTION_SILENTLY_RESOLVED", `tasks[${index}].context`, `Task ${task.id} silently resolves ${question.id}.`));
  }
  const mappings = new Map(plan.traceability.issueToValidation.map(({ issueId, validationIds: ids }) => [issueId, ids]));
  for (const issueId of accepted) { const ids = mappings.get(issueId) ?? []; if (ids.length === 0) diagnostics.push(diagnostic("ACCEPTED_ISSUE_REQUIRES_VALIDATION_ASSERTION", "traceability.issueToValidation", `Accepted issue ${issueId} must map to a validation assertion.`)); for (const id of ids) if (!validationIds.has(id)) diagnostics.push(diagnostic("UNKNOWN_ISSUE_VALIDATION_ASSERTION", "traceability.issueToValidation", `Issue ${issueId} references unknown validation assertion ${id}.`)); }
  if (plan.mode === "feature") for (const [index, link] of plan.traceability.requirementLinks.links.entries()) { if (link.validationIds.some((id) => !validationIds.has(id)) || link.taskIds.some((id) => !taskIds.has(id))) diagnostics.push(diagnostic("FEATURE_REQUIREMENT_LINK_INVALID", `traceability.requirementLinks.links[${index}]`, `Requirement ${link.requirementId} must retain valid task and validation links.`)); }
  diagnostics.push(...validateTaskGraph(plan));
  return Object.freeze(diagnostics);
}

function validateTaskGraph(plan: TraceablePlan): TraceabilityDiagnostic[] {
  const diagnostics: TraceabilityDiagnostic[] = [];
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const edges = new Map<string, Set<string>>(plan.tasks.map(({ id }) => [id, new Set<string>()]));
  const declared = new Set<string>();
  const rendered = new Set<string>();
  const edgeKey = (from: string, to: string) => JSON.stringify([from, to]);
  const invalid = (message: string) => diagnostics.push(diagnostic("INVALID_TASK_GRAPH", "taskGraph", message));
  const add = (from: string, to: string) => {
    if (from === to || !tasks.has(from) || !tasks.has(to)) { invalid(`Invalid dependency ${from} -> ${to}.`); return; }
    edges.get(from)?.add(to);
  };
  for (const task of plan.tasks) {
    if (task.dependencies === undefined) continue;
    for (const from of task.dependencies.dependsOn) { add(from, task.id); declared.add(edgeKey(from, task.id)); }
    for (const to of task.dependencies.blocks) { add(task.id, to); declared.add(edgeKey(task.id, to)); }
    for (const other of task.dependencies.conflictsWith) if (other === task.id || !tasks.has(other)) invalid(`Invalid conflict ${task.id} / ${other}.`);
  }
  for (const { from, to } of plan.taskGraph ?? []) {
    const key = edgeKey(from, to);
    if (rendered.has(key)) invalid(`Duplicate dependency ${from} -> ${to}.`);
    rendered.add(key); add(from, to);
    if (tasks.get(from)?.dependencies !== undefined && tasks.get(to)?.dependencies !== undefined && !declared.has(key)) invalid(`Graph edge ${from} -> ${to} is absent from task dependencies.`);
  }
  if (plan.taskGraph !== undefined) for (const key of declared) if (!rendered.has(key)) invalid(`Task dependency ${key} is absent from taskGraph.`);
  const degrees = new Map([...tasks.keys()].map((id) => [id, 0]));
  for (const successors of edges.values()) for (const id of successors) degrees.set(id, (degrees.get(id) ?? 0) + 1);
  const ready = [...degrees].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index]; if (id === undefined) continue;
    visited += 1;
    for (const next of edges.get(id) ?? []) { const degree = (degrees.get(next) ?? 0) - 1; degrees.set(next, degree); if (degree === 0) ready.push(next); }
  }
  if (visited !== tasks.size) diagnostics.push(diagnostic("TASK_GRAPH_CYCLE", "taskGraph", "Task dependencies must form an acyclic graph."));
  // Testing execution serialises shared writes itself (write leases); an Audit or Feature handoff
  // renders only dependsOn/blocks, so there the plan must order tasks that write the same files.
  else if (plan.mode !== "testing") diagnostics.push(...validateSharedWriteOrder(plan.tasks, edges));
  return diagnostics;
}

/** Tasks whose write scopes (likelyFiles minus filesNotToTouch; a directory covers its files)
 * overlap must be ordered by a dependency path (observed live: two tasks shared files and were
 * related only by conflictsWith). `edges` maps a task to the tasks that wait for it. */
export type WriteScopedTask = Pick<TraceablePlan["tasks"][number], "id" | "dependencies" | "scope" | "filesNotToTouch">;
export function validateSharedWriteOrder(tasks: readonly WriteScopedTask[], edges: ReadonlyMap<string, ReadonlySet<string>>): TraceabilityDiagnostic[] {
  const reach = new Map<string, ReadonlySet<string>>();
  const reachable = (id: string): ReadonlySet<string> => {
    const known = reach.get(id); if (known !== undefined) return known;
    const found = new Set<string>(); const stack = [...(edges.get(id) ?? [])];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) if (!found.has(next)) { found.add(next); stack.push(...(edges.get(next) ?? [])); }
    reach.set(id, found); return found;
  };
  const normalise = (path: string) => path.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/\*\*$/u, "").replace(/\/+$/u, "").toLowerCase();
  const writers = tasks.map((task, index) => {
    const excluded = new Set((task.filesNotToTouch ?? []).map(normalise));
    const paths = new Map<string, string>(); for (const path of task.scope?.likelyFiles ?? []) { const key = normalise(path); if (key !== "" && !excluded.has(key) && !paths.has(key)) paths.set(key, path); }
    return { task, index, paths };
  }).filter(({ paths }) => paths.size > 0);
  const covers = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const diagnostics: TraceabilityDiagnostic[] = []; const seen = new Set<string>(); let omitted = 0;
  for (const [position, left] of writers.entries()) for (const right of writers.slice(position + 1)) {
    if (left.task.id === right.task.id) continue;
    const [first, second] = left.task.id.localeCompare(right.task.id) <= 0 ? [left, right] : [right, left];
    const key = JSON.stringify([first.task.id, second.task.id]); if (seen.has(key)) continue; seen.add(key);
    const shared = [...first.paths].filter(([path]) => [...second.paths.keys()].some((other) => covers(path, other))).map(([, original]) => original);
    if (shared.length === 0 || reachable(first.task.id).has(second.task.id) || reachable(second.task.id).has(first.task.id)) continue;
    if (diagnostics.length >= 10) { omitted += 1; continue; }
    diagnostics.push(diagnostic("SHARED_WRITE_SCOPE_UNORDERED", `tasks[${second.index}].dependencies.dependsOn`, `Tasks ${first.task.id} and ${second.task.id} both write ${shared.slice(0, 5).join(", ")} (scope.likelyFiles) but neither depends on the other; conflictsWith does not order tasks. Order them: add ${first.task.id} to ${second.task.id}.dependencies.dependsOn and {"from":"${first.task.id}","to":"${second.task.id}"} to taskGraph (reverse both if ${second.task.id} must land first), or merge the two tasks. Do not drop a file a task must edit from its likelyFiles.`));
  }
  if (omitted > 0) diagnostics.push(diagnostic("SHARED_WRITE_SCOPE_UNORDERED", "tasks", `${omitted} more task pairs share files without an order.`));
  return diagnostics;
}
/** The dependency edges a plan states (`from` finishes before `to`), from dependsOn, blocks and
 * taskGraph plus any extra edges; references to unknown tasks are left to the full check. */
export function dependencyEdges(tasks: readonly WriteScopedTask[], taskGraph: TraceablePlan["taskGraph"] = [], extra: readonly { readonly from: string; readonly to: string }[] = []): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>(tasks.map(({ id }) => [id, new Set<string>()]));
  const add = (from: string, to: string) => { if (from !== to && edges.has(to)) edges.get(from)?.add(to); };
  for (const task of tasks) { for (const from of task.dependencies?.dependsOn ?? []) add(from, task.id); for (const to of task.dependencies?.blocks ?? []) add(task.id, to); }
  for (const { from, to } of [...taskGraph, ...extra]) add(from, to);
  return edges;
}
function diagnostic(code: TraceabilityDiagnostic["code"], path: string, message: string): TraceabilityDiagnostic { return Object.freeze({ code, path, message }); }
