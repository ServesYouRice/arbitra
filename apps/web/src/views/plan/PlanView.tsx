import "./plan.css";
import { useMemo, type ReactElement } from "react";
import { ArtifactApi } from "../../api/artifacts.js";
import type { PersistedFinding, PersistedIssueSet } from "../issue-board/model.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact, type RunArtifact } from "../issue-board/run-artifacts.js";
import type { PersistedCritique, PersistedPlan, TraceGraph, TraceLevel } from "./traceability.js";

export interface PlanData { readonly plan: RunArtifact<PersistedPlan>; readonly critique: RunArtifact<PersistedCritique>; readonly graph: TraceGraph | null }

/** The plan and what it traces back to: the canonical issues and their source findings, when the run has them. */
export function usePlan(api: ArtifactApi, runId: string | null, refreshKey: unknown): PlanData {
  const plan = useRunArtifact<PersistedPlan>(api, runId, RUN_ARTIFACT_KINDS.plan, refreshKey);
  const issueSet = useRunArtifact<PersistedIssueSet>(api, runId, RUN_ARTIFACT_KINDS.canonicalIssues, refreshKey);
  const findings = useRunArtifact<readonly PersistedFinding[]>(api, runId, RUN_ARTIFACT_KINDS.sourceFindings, refreshKey);
  const critique = useRunArtifact<PersistedCritique>(api, runId, RUN_ARTIFACT_KINDS.criticFeedback, refreshKey);
  const graph = useMemo(() => plan.value === null ? null : { plan: plan.value, issues: issueSet.value?.issues ?? [], findings: findings.value ?? [] }, [plan.value, issueSet.value, findings.value]);
  return { plan, critique, graph };
}

export interface PlanViewProps { readonly runId: string | null; readonly api?: ArtifactApi; readonly refreshKey?: unknown; readonly selected?: { readonly level: TraceLevel; readonly id: string } | null; readonly onSelect?: (level: TraceLevel, id: string) => void }

/**
 * The implementation plan as recorded. What stops it passing its gate comes first: open
 * blocking questions and blocking critic objections. Selecting a task or a validation
 * assertion traces it through the issues to the source evidence in the details panel.
 */
export function PlanView({ runId, api = SHARED_ARTIFACT_API, refreshKey = null, selected = null, onSelect }: PlanViewProps): ReactElement {
  const { plan, critique } = usePlan(api, runId, refreshKey);
  if (plan.state !== "loaded" || plan.value === null) return <section aria-label="plan"><h2 className="panel-title">plan</h2><p className="state" data-state={plan.state === "error" ? "degraded" : "unexamined"}>plan artifact {plan.state === "error" ? `unavailable · ${plan.error ?? "error"}` : plan.state}</p></section>;
  const value = plan.value;
  const questions = [...value.unresolvedQuestions].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const isSelected = (level: TraceLevel, id: string): boolean => selected?.level === level && selected.id === id;
  return <section aria-label="plan" className="plan-view">
    <h2 className="panel-title">plan</h2>
    <p className="plan-title">{value.title} · mode {value.mode} · {value.acceptedIssueIds.length} planned canonical issues · {value.tasks.length} tasks</p>
    <p className="state" data-state={value.premiseReport.status === "positive" ? "verified" : value.premiseReport.status === "negative" ? "refuted" : "unexamined"}>premise · {value.premiseReport.status} · {value.premiseReport.interpretation}{value.premiseReport.limitations.length === 0 ? "" : ` · ${value.premiseReport.limitations.join(" · ")}`}</p>
    {questions.length === 0 ? null : <section aria-labelledby="questions-title" className="plan-section">
      <h3 className="panel-title" id="questions-title">unresolved questions</h3>
      <ul className="plain-list">{questions.map(({ id, question, blocking, blastRadius }) => <li className="state" data-state={blocking ? "refuted" : "degraded"} key={id}>{id} · {question} · blast radius {blastRadius}{blocking ? " · blocks the plan gate" : ""}</li>)}</ul>
    </section>}
    <section aria-labelledby="critic-title" className="plan-section">
      <h3 className="panel-title" id="critic-title">critic feedback</h3>
      {critique.state !== "loaded" || critique.value === null ? <p className="state" data-state={critique.state === "error" ? "degraded" : "unexamined"}>critic feedback {critique.state === "error" ? `unavailable · ${critique.error ?? "error"}` : critique.state}</p> : <>
        <p className="data">{critique.value.summary}</p>
        {critique.value.items.length === 0 ? null : <ul className="plain-list">{[...critique.value.items].sort((a, b) => Number(b.blocking) - Number(a.blocking)).map((item) => <li className="state" data-state={item.blocking ? "refuted" : "dissent"} key={item.id}>{item.category} · {item.blocking ? "blocking" : "non-blocking"} · {item.summary} · tasks {item.taskIds.join(", ") || "none"} · issues {item.issueIds.join(", ") || "none"}</li>)}</ul>}
      </>}
    </section>
    <section aria-labelledby="tasks-title" className="plan-section">
      <h3 className="panel-title" id="tasks-title">tasks and capability routing</h3>
      <div className="table-scroll"><table aria-label="plan tasks" className="table plan-tasks">
        <thead><tr><th scope="col">task</th><th scope="col">title</th><th scope="col">routing</th><th scope="col">validation</th><th scope="col">issues</th><th scope="col">depends on</th></tr></thead>
        <tbody>{value.tasks.map((task) => { const routing = value.routingRecommendations.find(({ taskId }) => taskId === task.id) ?? null; return <tr className="plan-task" data-selected={isSelected("task", task.id)} key={task.id}>
          <td className="nowrap"><button aria-pressed={isSelected("task", task.id)} className="link-button" type="button" onClick={() => onSelect?.("task", task.id)}>{task.id}</button></td>
          <td className="plan-task__title">{task.title}</td>
          <td>{routingText(task.routing, routing)}</td>
          <td className="ids">{task.addresses.validation.join(", ") || "none"}</td>
          <td className="ids">{task.addresses.issues.join(", ") || "none"}</td>
          <td className="ids">{task.dependencies.dependsOn.join(", ") || "none"}</td>
        </tr>; })}</tbody>
      </table></div>
    </section>
    <section aria-labelledby="validation-contract-title" className="plan-section">
      <h3 className="panel-title" id="validation-contract-title">validation contract</h3>
      <ul className="plain-list">{value.validationContract.validation.map(({ id, assertion, evidence }) => <li data-selected={isSelected("validation", id)} key={id}><button aria-pressed={isSelected("validation", id)} className="link-button" type="button" onClick={() => onSelect?.("validation", id)}>{id}</button> · {assertion} · evidence {evidence.join(", ")}</li>)}</ul>
    </section>
    <section aria-labelledby="graph-title-plan" className="plan-section">
      <h3 className="panel-title" id="graph-title-plan">dependency graph</h3>
      {value.taskGraph.length === 0 ? <p className="state" data-state="unexamined">no recorded task dependencies</p> : <ul className="plain-list">{value.taskGraph.map(({ from, to }) => <li key={`${from}-${to}`}>{from} → {to}</li>)}</ul>}
    </section>
  </section>;
}
/** The routing a task carries, and the planner's recommendation only where it differs. */
export function routingText(routing: { readonly capability: string; readonly effort: string; readonly reason: readonly string[] }, recommended: { readonly capability: string; readonly effort: string; readonly reason: readonly string[] } | null): string {
  const differs = recommended !== null && (recommended.capability !== routing.capability || recommended.effort !== routing.effort);
  const reasons = (recommended?.reason ?? routing.reason).join("; ");
  return `${routing.capability} / ${routing.effort}${differs ? ` · recommended ${recommended.capability} / ${recommended.effort}` : ""}${reasons === "" ? "" : ` · ${reasons}`}`;
}
const SHARED_ARTIFACT_API = new ArtifactApi();
