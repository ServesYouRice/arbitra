import type { ReactElement } from "react";
import { useLoaded } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { Link } from "../../app/router.js";
import { tierWord } from "../../app/words.js";
import type { PersistedIssueSet } from "../../views/issue-board/model.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact } from "../../views/issue-board/run-artifacts.js";
import type { PersistedPlan, PersistedPlanTask } from "../../views/plan/traceability.js";

/** The parts of a task the plan records beyond its routing: its goal, the files it touches and how to tell it is done. */
type PlanTask = PersistedPlanTask & {
  readonly goal?: { readonly objective?: string; readonly doneWhen?: readonly string[] };
  readonly scope?: { readonly likelyFiles?: readonly string[] };
  readonly acceptanceCriteria?: readonly string[];
  readonly verification?: { readonly commands?: readonly { readonly command: string }[] };
};

/**
 * One task one click down, in plain words: what it is for, the issues it fixes (each a link to the issue), how to tell
 * it is done, the files it is likely to change, the model it needs and what it waits for. The recorded codes are last.
 */
export function TaskPanel({ runId, taskId, refreshKey }: { readonly runId: string; readonly taskId: string; readonly refreshKey: unknown }): ReactElement {
  const { artifacts: api, runs } = useApis();
  const plan = useRunArtifact<PersistedPlan>(api, runId, RUN_ARTIFACT_KINDS.plan, refreshKey);
  const issues = useRunArtifact<PersistedIssueSet>(api, runId, RUN_ARTIFACT_KINDS.canonicalIssues, refreshKey).value;
  const outline = useLoaded(`plan-outline:${runId}`, () => runs.planOutline(runId), refreshKey).value;
  if (plan.value === null) return <p className="state" data-state={plan.state === "error" ? "degraded" : "unexamined"} role={plan.state === "loading" ? "status" : undefined}>{plan.state === "loading" ? "reading the task" : "The plan could not be read."}</p>;
  const task = plan.value.tasks.find(({ id }) => id === taskId) as PlanTask | undefined;
  if (task === undefined) return <p className="state" data-state="unexamined">The plan has no task {taskId}.</p>;
  const order = outline?.tasks.find(({ id }) => id === taskId);
  const position = outline?.tasks.findIndex(({ id }) => id === taskId) ?? -1;
  const done = [...task.goal?.doneWhen ?? [], ...task.acceptanceCriteria ?? []];
  const waits = order === undefined ? [] : [...order.after.length === 0 ? [] : [`after ${order.after.join(", ")}`], ...order.sameFilesAs.length === 0 ? [] : [`same files as ${order.sameFilesAs.join(", ")}`]];
  return <div className="details-stack task-panel">
    <h3 className="issue-panel__title">{task.title}</h3>
    <p className="data">{[`${tierWord(task.routing.capability)} model`, ...waits].join(" · ")}</p>
    {task.goal?.objective === undefined ? null : <p className="prose">{task.goal.objective}</p>}
    <section aria-label="what it fixes" className="details-section">
      <h4 className="panel-title">Fixes</h4>
      {task.addresses.issues.length === 0 ? <p className="note">No issue: the plan added it to support the others.</p>
        : <ul className="plain-list">{task.addresses.issues.map((id) => <li key={id}><Link to={{ page: "run", runId, tab: "issues", item: `issue:${id}` }}>{issues?.issues.find(({ candidateId }) => candidateId === id)?.claim.title ?? id}</Link></li>)}</ul>}
    </section>
    {done.length === 0 ? null : <section aria-label="done when" className="details-section">
      <h4 className="panel-title">Done when</h4>
      <ul className="plain-list">{done.map((line, index) => <li className="prose" key={index}>{line}</li>)}</ul>
    </section>}
    {(task.scope?.likelyFiles ?? []).length === 0 ? null : <section aria-label="files" className="details-section">
      <h4 className="panel-title">Files it is likely to change</h4>
      <ul className="plain-list">{(task.scope?.likelyFiles ?? []).map((path) => <li key={path}><code>{path}</code></li>)}</ul>
    </section>}
    {task.routing.reason.length === 0 ? null : <p className="note">Why that model: {task.routing.reason.join("; ")}.</p>}
    <details className="disclosure">
      <summary>Recorded codes</summary>
      <dl className="facts">
        <div><dt>task</dt><dd><code>{task.id}</code>{position < 0 ? "" : ` · number ${position + 1} in the order of work`}</dd></div>
        <div><dt>routing</dt><dd><code>{task.routing.capability} / {task.routing.effort}</code>{order === undefined ? "" : <> · prompts/<code>{order.folder}</code></>}</dd></div>
        <div><dt>depends on</dt><dd>{task.dependencies.dependsOn.join(", ") || "none"}</dd></div>
        {(task.verification?.commands ?? []).length === 0 ? null : <div><dt>commands</dt><dd><ul className="plain-list">{(task.verification?.commands ?? []).map(({ command }) => <li key={command}><code>{command}</code></li>)}</ul></dd></div>}
      </dl>
    </details>
  </div>;
}
