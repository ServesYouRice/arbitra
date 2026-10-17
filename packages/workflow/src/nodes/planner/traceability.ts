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
  const writers = writeScopes(tasks);
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
/** Each task's write scope by normalised path, with the path as the plan wrote it; tasks that write nothing are left out. */
function writeScopes<TTask extends WriteScopedTask>(tasks: readonly TTask[]): { readonly task: TTask; readonly index: number; readonly paths: Map<string, string> }[] {
  const normalise = (path: string) => path.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/\*\*$/u, "").replace(/\/+$/u, "").toLowerCase();
  return tasks.map((task, index) => {
    const excluded = new Set((task.filesNotToTouch ?? []).map(normalise));
    const paths = new Map<string, string>(); for (const path of task.scope?.likelyFiles ?? []) { const key = normalise(path); if (key !== "" && !excluded.has(key) && !paths.has(key)) paths.set(key, path); }
    return { task, index, paths };
  }).filter(({ paths }) => paths.size > 0);
}
function covers(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }

/**
 * Orders the tasks whose write scopes overlap and that the plan leaves unordered: the later task (by id) waits
 * for the nearest earlier one, in its `dependsOn` and in `taskGraph`. A plan states the orders that matter, so
 * what it leaves unordered is independent work on the same files, and any order serialises that. Observed live
 * (P20 pilot): a plan for 45 issues left such pairs unordered and was refused, and the repair wrote the whole
 * plan again, 60,000 output tokens in eight minutes, to add the edges the refusal had spelled out. Testing
 * plans are returned as they are (their execution serialises shared writes itself), and so is a task without
 * `dependencies`; `validateSharedWriteOrder` still reports whatever stays unordered. A task with `context` says why it
 * waits (`SHARED_WRITE_ORDER_NOTE`), so a reader does not take the edge for a functional dependency: observed live
 * (P20 pilot), 27 of a critic's 108 blocking items objected to such edges as spurious, and its revision would have
 * removed edges the run adds back. It first makes the plan's two statements of order agree
 * (`withGraphMatchingDependencies`), in every mode.
 */
export function withSharedWritesOrdered<TPlan extends { readonly mode: TraceablePlan["mode"]; readonly tasks: readonly WriteScopedTask[]; readonly taskGraph?: TraceablePlan["taskGraph"] }>(stated: TPlan): TPlan {
  const plan = withGraphMatchingDependencies(stated);
  if (plan.mode === "testing") return plan;
  const edges = dependencyEdges(plan.tasks, plan.taskGraph);
  const reaches = (from: string, to: string): boolean => {
    const found = new Set<string>(); const stack = [...(edges.get(from) ?? [])];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) { if (next === to) return true; if (!found.has(next)) { found.add(next); stack.push(...(edges.get(next) ?? [])); } }
    return false;
  };
  const writers = writeScopes(plan.tasks).sort((left, right) => left.task.id.localeCompare(right.task.id));
  const added: { from: string; to: string; paths: readonly string[] }[] = [];
  for (const [position, second] of writers.entries()) {
    if (second.task.dependencies === undefined) continue;
    // The nearest earlier writer first, so the writers of one file form a chain and not every pair.
    for (const first of writers.slice(0, position).reverse()) {
      const shared = [...first.paths].filter(([path]) => [...second.paths.keys()].some((other) => covers(path, other))).map(([, original]) => original);
      if (first.task.id === second.task.id || shared.length === 0) continue;
      if (reaches(first.task.id, second.task.id) || reaches(second.task.id, first.task.id)) continue;
      edges.get(first.task.id)?.add(second.task.id); added.push({ from: first.task.id, to: second.task.id, paths: shared });
    }
  }
  if (added.length === 0) return plan;
  return { ...plan,
    tasks: plan.tasks.map((task) => {
      const earlier = added.filter(({ to }) => to === task.id);
      if (earlier.length === 0 || task.dependencies === undefined) return task;
      const context = (task as { readonly context?: unknown }).context;
      return { ...task, dependencies: { ...task.dependencies, dependsOn: [...task.dependencies.dependsOn, ...earlier.map(({ from }) => from)] },
        ...(Array.isArray(context) ? { context: [...context as string[], ...earlier.map(({ from, paths }) => sharedWriteOrderNote(from, paths))] } : {}) };
    }),
    ...(plan.taskGraph === undefined ? {} : { taskGraph: [...plan.taskGraph, ...added.map(({ from, to }) => ({ from, to }))] }) } as TPlan;
}
/**
 * A plan states each order twice: in its tasks' `dependsOn` and `blocks`, and in `taskGraph`. Where the two disagree,
 * an order stated in one place is added to the other, and an edge stated twice in `taskGraph` is kept once, so no
 * stated order is lost and none is invented. An edge naming an unknown task or the task itself, and a cycle, are left
 * to the full check. Observed live (P20 pilot, October 17): a plan section was refused because one `dependsOn` was
 * missing from `taskGraph`, and its repair wrote the whole section again, 30,000 output tokens in four minutes.
 */
export function withGraphMatchingDependencies<TPlan extends { readonly tasks: readonly WriteScopedTask[]; readonly taskGraph?: TraceablePlan["taskGraph"] }>(plan: TPlan): TPlan {
  if (plan.taskGraph === undefined) return plan;
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const key = ({ from, to }: { readonly from: string; readonly to: string }) => JSON.stringify([from, to]);
  const declared = new Map<string, { from: string; to: string }>();
  for (const task of plan.tasks) {
    for (const from of task.dependencies?.dependsOn ?? []) declared.set(key({ from, to: task.id }), { from, to: task.id });
    for (const to of task.dependencies?.blocks ?? []) declared.set(key({ from: task.id, to }), { from: task.id, to });
  }
  const rendered = new Map(plan.taskGraph.map((edge) => [key(edge), edge]));
  const known = ({ from, to }: { readonly from: string; readonly to: string }) => from !== to && tasks.has(from) && tasks.has(to);
  const toGraph = [...declared].filter(([edge, stated]) => !rendered.has(edge) && known(stated)).map(([, stated]) => stated);
  // The full check compares the two only where both tasks state their dependencies, so only those gain one.
  const toTasks = [...rendered].filter(([edge, stated]) => !declared.has(edge) && known(stated) && tasks.get(stated.from)?.dependencies !== undefined && tasks.get(stated.to)?.dependencies !== undefined).map(([, stated]) => stated);
  if (toGraph.length === 0 && toTasks.length === 0 && rendered.size === plan.taskGraph.length) return plan;
  return { ...plan,
    tasks: plan.tasks.map((task) => {
      const earlier = toTasks.filter(({ to }) => to === task.id).map(({ from }) => from);
      return earlier.length === 0 || task.dependencies === undefined ? task : { ...task, dependencies: { ...task.dependencies, dependsOn: [...task.dependencies.dependsOn, ...earlier] } };
    }),
    taskGraph: [...rendered.values(), ...toGraph] } as TPlan;
}
/** The start of what a task's context says about a dependency the run added only to order edits to shared files. */
export const SHARED_WRITE_ORDER_NOTE = "Ordered by arbitra, not a functional dependency:";
function sharedWriteOrderNote(from: string, paths: readonly string[]): string {
  return `${SHARED_WRITE_ORDER_NOTE} waits for ${from} because both edit ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? " and more" : ""}, so their changes land one after the other.`;
}
function diagnostic(code: TraceabilityDiagnostic["code"], path: string, message: string): TraceabilityDiagnostic { return Object.freeze({ code, path, message }); }
