import { useRef, useState, type ReactElement } from "react";
import type { ArtifactApi } from "../../api/artifacts.js";
import { usePlan } from "./PlanView.js";
import { backward, findTraceNode, forward, TRACE_CHAIN, type TraceLevel, type TraceNode } from "./traceability.js";

/**
 * Traceability for one plan node: forward toward the source evidence, backward toward the
 * tasks. The trail records the steps taken from the first node selected in the plan, so the
 * whole path from a task to its evidence stays in view; selecting a step rewinds to it.
 */
export function TraceDetails({ api, runId, level, id, refreshKey = null, onSelect }: { readonly api: ArtifactApi; readonly runId: string; readonly level: TraceLevel; readonly id: string; readonly refreshKey?: unknown; readonly onSelect: (level: TraceLevel, id: string) => void }): ReactElement {
  const { plan, graph } = usePlan(api, runId, refreshKey);
  const [trail, setTrail] = useState<readonly { level: TraceLevel; id: string }[]>([{ level, id }]);
  const stepping = useRef<{ level: TraceLevel; id: string } | null>(null);
  // A step taken here extends the trail; any other change of selection starts a new one.
  const head = trail.at(-1);
  if (head === undefined || head.level !== level || head.id !== id) {
    const step = stepping.current;
    const existing = trail.findIndex((entry) => entry.level === level && entry.id === id);
    setTrail(existing !== -1 ? trail.slice(0, existing + 1) : step !== null && step.level === level && step.id === id ? [...trail, { level, id }] : [{ level, id }]);
    stepping.current = null;
  }
  const go = (next: TraceNode): void => { stepping.current = { level: next.level, id: next.id }; onSelect(next.level, next.id); };
  if (graph === null) return <p className="state" data-state={plan.state === "error" ? "degraded" : "unexamined"}>plan artifact {plan.state === "error" ? `unavailable · ${plan.error ?? "error"}` : plan.state}</p>;
  const node = findTraceNode(graph, level, id);
  if (node === null) return <p className="state" data-state="unexamined">{level} {id} is not recorded in this run's plan</p>;
  const task = level === "task" ? graph.plan.tasks.find((entry) => entry.id === id) : undefined;
  const ahead = forward(graph, node);
  const behind = backward(graph, node);
  return <div className="details-stack">
    <p className="note">traceability · {TRACE_CHAIN.join(" → ")}</p>
    <ol aria-label="traceability trail" className="plain-list trace-trail">{trail.map((entry, index) => { const label = findTraceNode(graph, entry.level, entry.id)?.label ?? "unavailable"; return <li key={`${entry.level}:${entry.id}:${index}`}>{index === trail.length - 1 ? <strong>{entry.level} · {entry.id}</strong> : <button className="link-button" type="button" onClick={() => go({ level: entry.level, id: entry.id, label })}>{entry.level} · {entry.id}</button>}{index === trail.length - 1 ? null : <span className="muted"> · {label}</span>}</li>; })}</ol>
    <p className="prose">{node.label}</p>
    {task === undefined ? null : <dl className="facts">
      <div><dt>routing</dt><dd>{task.routing.capability} / {task.routing.effort}{task.routing.reason.length === 0 ? "" : ` · ${task.routing.reason.join("; ")}`}</dd></div>
      <div><dt>depends on</dt><dd>{task.dependencies.dependsOn.join(", ") || "none"}</dd></div>
      <div><dt>conflicts with</dt><dd>{task.dependencies.conflictsWith.join(", ") || "none"}</dd></div>
      <div><dt>requirements</dt><dd>{task.addresses.requirements.join(", ") || "none"}</dd></div>
    </dl>}
    <section className="details-section" aria-label="forward links">
      <h3 className="panel-title">traces to</h3>
      {ahead.length === 0 ? <p className="state" data-state="unexamined">no persisted forward link from this {level}</p> : <ul className="plain-list">{ahead.map((next) => <li key={`${next.level}:${next.id}`}><button className="link-button" type="button" onClick={() => go(next)}>{next.level} · {next.id}</button> · {next.label}</li>)}</ul>}
    </section>
    <section className="details-section" aria-label="backward links">
      <h3 className="panel-title">traced from</h3>
      {behind.length === 0 ? <p className="state" data-state="unexamined">no persisted backward link from this {level}</p> : <ul className="plain-list">{behind.map((next) => <li key={`${next.level}:${next.id}`}><button className="link-button" type="button" onClick={() => go(next)}>{next.level} · {next.id}</button> · {next.label}</li>)}</ul>}
    </section>
  </div>;
}
