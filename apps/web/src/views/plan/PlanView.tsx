import { useMemo, useState, type ReactElement } from "react";
import { ArtifactApi } from "../../api/artifacts.js";
import type { PersistedFinding, PersistedIssueSet } from "../issue-board/model.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact } from "../issue-board/run-artifacts.js";
import { backward, forward, TRACE_CHAIN, type PersistedCritique, type PersistedPlan, type TraceGraph, type TraceNode } from "./traceability.js";
export interface PlanViewProps { readonly runId: string | null; readonly api?: ArtifactApi }
export function PlanView({ runId, api = SHARED_ARTIFACT_API }: PlanViewProps): ReactElement {
  const plan = useRunArtifact<PersistedPlan>(api, runId, RUN_ARTIFACT_KINDS.plan);
  const issueSet = useRunArtifact<PersistedIssueSet>(api, runId, RUN_ARTIFACT_KINDS.canonicalIssues);
  const findings = useRunArtifact<readonly PersistedFinding[]>(api, runId, RUN_ARTIFACT_KINDS.sourceFindings);
  const critique = useRunArtifact<PersistedCritique>(api, runId, RUN_ARTIFACT_KINDS.criticFeedback);
  const [trail, setTrail] = useState<readonly TraceNode[]>([]);
  const graph: TraceGraph | null = useMemo(() => plan.value === null ? null : { plan: plan.value, issues: issueSet.value?.issues ?? [], findings: findings.value ?? [] }, [plan.value, issueSet.value, findings.value]);
  if (plan.state !== "loaded" || plan.value === null || graph === null) return <section aria-label="plan"><h2 className="panel-title">plan</h2><p className="state" data-state={plan.state === "error" ? "degraded" : "unexamined"}>plan artifact {plan.state === "error" ? `unavailable · ${plan.error ?? "error"}` : plan.state}</p></section>;
  const value = plan.value;
  const head = trail.at(-1) ?? null;
  const step = (node: TraceNode): void => setTrail((current) => { const existing = current.findIndex(({ level, id }) => level === node.level && id === node.id); return existing === -1 ? Object.freeze([...current, node]) : Object.freeze(current.slice(0, existing + 1)); });
  return <section aria-label="plan" className="plan-view">
    <h2 className="panel-title">plan</h2>
    <p className="plan-title">{value.title} · mode {value.mode} · {value.acceptedIssueIds.length} accepted canonical issues · {value.tasks.length} tasks</p>
    <p className="state" data-state={value.premiseReport.status === "positive" ? "verified" : value.premiseReport.status === "negative" ? "refuted" : "unexamined"}>premise · {value.premiseReport.status} · {value.premiseReport.interpretation} · {value.premiseReport.limitations.join(" · ")}</p>
    <section aria-labelledby="validation-contract-title"><h3 className="panel-title" id="validation-contract-title">validation contract</h3><ul>{value.validationContract.validation.map(({ id, assertion, evidence }) => <li key={id}><button type="button" onClick={() => step({ level: "validation", id, label: assertion })}>{id}</button> · {assertion} · evidence {evidence.join(", ")}</li>)}</ul></section>
    <section aria-labelledby="tasks-title"><h3 className="panel-title" id="tasks-title">tasks and capability routing</h3><ol className="plan-tasks">{value.tasks.map((task) => { const routing = value.routingRecommendations.find(({ taskId }) => taskId === task.id) ?? null; return <li className="plan-task" key={task.id}><button type="button" onClick={() => step({ level: "task", id: task.id, label: task.title })}>{task.id}</button> · {task.title} · {task.routing.capability} / {task.routing.effort}{routing === null ? "" : ` · recommended ${routing.capability} / ${routing.effort} · ${routing.reason.join("; ")}`} · validation {task.addresses.validation.join(", ") || "none"} · issues {task.addresses.issues.join(", ") || "none"}</li>; })}</ol></section>
    <section aria-labelledby="graph-title-plan"><h3 className="panel-title" id="graph-title-plan">dependency graph</h3>{value.taskGraph.length === 0 ? <p className="state" data-state="unexamined">no recorded task dependencies</p> : <ul>{value.taskGraph.map(({ from, to }) => <li key={`${from}-${to}`}>{from} → {to}</li>)}</ul>}</section>
    <section aria-labelledby="critic-title"><h3 className="panel-title" id="critic-title">critic feedback</h3>{critique.state !== "loaded" || critique.value === null ? <p className="state" data-state={critique.state === "error" ? "degraded" : "unexamined"}>critic feedback {critique.state === "error" ? `unavailable · ${critique.error ?? "error"}` : critique.state}</p> : <><p>{critique.value.summary}</p><ul>{critique.value.items.map((item) => <li className="state" data-state={item.blocking ? "refuted" : "dissent"} key={item.id}>{item.category} · {item.blocking ? "blocking" : "non-blocking"} · {item.summary} · tasks {item.taskIds.join(", ") || "none"} · issues {item.issueIds.join(", ") || "none"}</li>)}</ul></>}</section>
    {value.unresolvedQuestions.length === 0 ? null : <section aria-labelledby="questions-title"><h3 className="panel-title" id="questions-title">unresolved questions</h3><ul>{value.unresolvedQuestions.map(({ id, question, blocking, blastRadius }) => <li className="state" data-state={blocking ? "refuted" : "degraded"} key={id}>{id} · {question} · blast radius {blastRadius}</li>)}</ul></section>}
    <section aria-label="traceability" className="plan-trace">
      <h3 className="panel-title">traceability · {TRACE_CHAIN.join(" → ")}</h3>
      {trail.length === 0 ? <p className="state" data-state="unexamined">select a task or validation assertion to trace it to its source evidence</p> : <ol aria-label="traceability trail" className="trace-trail">{trail.map((node) => <li key={`${node.level}:${node.id}`}><button type="button" onClick={() => step(node)}>{node.level} · {node.id}</button> · {node.label}</li>)}</ol>}
      {head === null ? null : <div className="trace-links">
        <div><h4 className="panel-title">forward</h4>{forward(graph, head).length === 0 ? <p className="state" data-state="unexamined">no persisted forward link from this {head.level}</p> : <ul aria-label="forward links">{forward(graph, head).map((node) => <li key={`${node.level}:${node.id}`}><button type="button" onClick={() => setTrail((current) => Object.freeze([...current, node]))}>{node.level} · {node.id}</button> · {node.label}</li>)}</ul>}</div>
        <div><h4 className="panel-title">backward</h4>{backward(graph, head).length === 0 ? <p className="state" data-state="unexamined">no persisted backward link from this {head.level}</p> : <ul aria-label="backward links">{backward(graph, head).map((node) => <li key={`${node.level}:${node.id}`}><button type="button" onClick={() => setTrail((current) => Object.freeze([...current, node]))}>{node.level} · {node.id}</button> · {node.label}</li>)}</ul>}</div>
      </div>}
      {trail.length === 0 ? null : <button type="button" onClick={() => setTrail([])}>clear trail</button>}
    </section>
  </section>;
}
const SHARED_ARTIFACT_API = new ArtifactApi();
