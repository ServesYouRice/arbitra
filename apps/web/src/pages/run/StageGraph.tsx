import "./stage-graph.css";
import { NODE_GLYPHS, type NodeKind } from "@arbitra/schemas/glyphs";
import { Fragment, useMemo, type ReactElement } from "react";
import type { RunProgress } from "../../api/runs.js";
import type { RunEvent } from "../../api/sse.js";
import { projectLiveState } from "../../graph/GraphView.js";
import type { WorkflowJson } from "../../graph/layout.js";
import { clock, stepName, type Mode } from "../../app/words.js";

export type StageStatus = RunProgress["stages"][number]["status"];
export interface StageView { readonly id: string; readonly kind: NodeKind; readonly name: string; readonly status: StageStatus; readonly elapsedMs: number | null; readonly model: string | null; readonly note: string | null }

/**
 * Where a run stands, drawn as its stages: boxes in the order they run, joined by lines, with stages that run side by
 * side (the finders) stacked. The lines into a running stage move; with reduced motion they stay still and the
 * stage's words say the same. Each box opens the stage's records in the details panel. Below 700px the stages stack
 * top to bottom, so a phone never scrolls sideways.
 */
export function StageGraph({ stages, workflow, selectedId, onSelect }: { readonly stages: readonly StageView[]; readonly workflow: WorkflowJson; readonly selectedId: string | null; readonly onSelect: (id: string) => void }): ReactElement {
  const columns = useMemo(() => layers(workflow).map((ids) => ids.flatMap((id) => stages.filter((stage) => stage.id === id))).filter((column) => column.length > 0), [workflow, stages]);
  const next = columns.find((column) => column.some(({ status }) => status === "waiting"));
  const nextIds = next === undefined || next.some(({ status }) => status === "running") ? new Set<string>() : new Set(next.filter(({ status }) => status === "waiting").map(({ id }) => id));
  return <div aria-label="stages" className="stage-graph" role="group">
    {columns.map((column, index) => <Fragment key={column.map(({ id }) => id).join(",")}>
      {index === 0 ? null : <Edge flow={column.some(({ status }) => status === "running") ? "live" : column.every(({ status }) => status === "done" || status === "reused") ? "done" : "idle"} />}
      <div className="stage-graph__column">{column.map((stage) => { const status = statusWords(stage, nextIds.has(stage.id)); return <button aria-current={stage.status === "running" ? "step" : undefined} aria-label={[stage.name, status, stage.model, stage.note].filter((line) => line !== null).join(" · ")} aria-pressed={stage.id === selectedId} className="stage" data-status={stage.status} key={stage.id} type="button" onClick={() => onSelect(stage.id)}>
        <span className="stage__name"><span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[stage.kind].token})` }}>{NODE_GLYPHS[stage.kind].glyph}</span> {stage.name}</span>
        <span className="stage__status">{status}</span>
        {stage.model === null ? null : <span>{stage.model}</span>}
        {stage.note === null ? null : <span>{stage.note}</span>}
      </button>; })}</div>
    </Fragment>)}
  </div>;
}

function Edge({ flow }: { readonly flow: "live" | "done" | "idle" }): ReactElement {
  // Two lines, one per direction the graph can run; the stylesheet shows the one the layout uses.
  return <span aria-hidden="true" className="stage-edge" data-flow={flow}><svg focusable="false"><line className="stage-edge__across" x1="0" x2="100%" y1="50%" y2="50%" /><line className="stage-edge__down" x1="50%" x2="50%" y1="0" y2="100%" /></svg></span>;
}

export function statusWords(stage: StageView, next: boolean): string {
  const time = stage.elapsedMs === null ? "" : ` · ${clock(stage.elapsedMs)}`;
  switch (stage.status) {
    case "running": return `running${time}`;
    case "done": return `done${time}`;
    case "reused": return "kept from before";
    case "failed": return "failed here";
    case "stopped": return `stopped${time}`;
    case "waiting": return next ? "next" : "waiting";
  }
}

/**
 * Each stage's view: the progress read when it has arrived, and otherwise the run's own event stream, which knows
 * running and done but no times. `now` counts a running stage's time on between two reads.
 */
export function stageViews({ workflow, mode, progress, events, now, models, notes }: {
  readonly workflow: WorkflowJson;
  readonly mode: Mode;
  readonly progress: RunProgress | null;
  readonly events: readonly RunEvent[];
  readonly now: number;
  readonly models: ReadonlyMap<string, string>;
  readonly notes: ReadonlyMap<string, string>;
}): readonly StageView[] {
  const live = projectLiveState(workflow, events);
  return workflow.nodes.map((node) => {
    const recorded = progress?.stages.find(({ nodeId }) => nodeId === node.id);
    const streamed = live.get(node.id)?.runtimeStatus;
    const status: StageStatus = recorded?.status ?? (streamed === "running" ? "running" : streamed === "completed" ? "done" : streamed === "replayed" ? "reused" : streamed === "failed" ? "failed" : "waiting");
    return { id: node.id, kind: node.kind, name: stepName(node, mode), status, elapsedMs: recorded === undefined ? null : stageElapsed(recorded, now), model: models.get(node.id) ?? null, note: notes.get(node.id) ?? null };
  });
}

/** Closed working time plus, for the interval still open, the time since it opened. */
export function stageElapsed(time: { readonly elapsedMs: number | null; readonly runningSince: string | null }, now: number): number | null {
  if (time.elapsedMs === null) return null;
  const since = time.runningSince === null ? Number.NaN : Date.parse(time.runningSince);
  return time.elapsedMs + (Number.isNaN(since) ? 0 : Math.max(0, now - since));
}

/** Nodes by their longest distance from the graph's start: stages that run side by side share a layer. */
export function layers(workflow: WorkflowJson): readonly (readonly string[])[] {
  const incoming = new Map(workflow.nodes.map(({ id }) => [id, workflow.edges.filter(({ to }) => to === id).map(({ from }) => from)]));
  const depth = new Map<string, number>();
  const visit = (id: string, trail: ReadonlySet<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    const next = new Set(trail).add(id);
    const value = Math.max(-1, ...(incoming.get(id) ?? []).filter((from) => incoming.has(from)).map((from) => visit(from, next))) + 1;
    depth.set(id, value);
    return value;
  };
  for (const { id } of workflow.nodes) visit(id, new Set());
  const result: string[][] = [];
  for (const { id } of workflow.nodes) (result[depth.get(id) ?? 0] ??= []).push(id);
  return result.filter((layer) => layer !== undefined);
}
