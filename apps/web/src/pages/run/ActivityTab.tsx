import { useMemo, type ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import type { RunOverview, RunResource } from "../../api/runs.js";
import type { RunEvent } from "../../api/sse.js";
import { useApis } from "../../app/apis.js";
import { artifactName, shortPath } from "../../app/format.js";
import { GraphView } from "../../graph/GraphView.js";
import { TraceView } from "../../views/traces/TraceView.js";
import { stepName, type Mode } from "../../app/words.js";
import { modelNodeLabels } from "./models.js";
import type { Selection } from "./selection.js";

/**
 * A node's name in the records: an Audit's steps by their names ("Read the project", "Merge duplicates"), since a
 * whole-project audit's graph is the diff graph's and its labels said "Diff scope" and "Disagreement" (UI inventory,
 * October 25, 2026); other graphs keep their labels. A model node adds the model and effort that ran it.
 */
export function recordLabel(node: { readonly id: string; readonly kind: string; readonly label: string }, mode: Mode, models: ReadonlyMap<string, string>): string {
  const model = models.get(node.id);
  return `${stepName(node, mode)}${model === undefined ? "" : ` · ${model}`}`;
}

function withRecordLabels<T extends { readonly nodes: readonly { readonly id: string; readonly kind: string; readonly label: string }[] }>(workflow: T, mode: Mode, configuration: Readonly<Record<string, unknown>> | null): T {
  const labels = modelNodeLabels(configuration);
  return { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, label: recordLabel(node, mode, labels) })) };
}

/**
 * What the run did, step by step: the executed graph with each node's status, every
 * recorded model attempt, and every persisted artifact. Each opens in the details panel.
 */
export function ActivityTab({ runId, mode, run, events, artifacts, overview, selection, onSelect }: {
  readonly runId: string;
  readonly mode: Mode;
  readonly run: RunResource | null;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly overview: RunOverview | null;
  readonly selection: Selection | null;
  readonly onSelect: (selection: Selection) => void;
}): ReactElement {
  const { traces } = useApis();
  // Steps read by their names, and model nodes as the model and effort that ran them ("Find issues · Opus 5.5 · xhigh").
  const workflow = useMemo(() => run?.workflow === undefined ? undefined : withRecordLabels(run.workflow, mode, overview?.configuration ?? null), [run?.workflow, mode, overview?.configuration]);
  return <div className="activity">
    {run?.workflow === undefined ? <p className="state" data-state="unexamined">{run === null ? "reading the run" : "no workflow recorded for this run"}</p>
      : <GraphView workflowJson={workflow ?? run.workflow} runEvents={events} artifacts={artifacts} selectedNodeId={selection?.kind === "node" ? selection.id : null} onSelect={(node) => onSelect({ kind: "node", id: node.id })} {...(run.workflowGraph === undefined ? {} : { identity: run.workflowGraph })} />}
    <TraceView api={traces} runId={runId} refreshKey={events.length} selectedTraceId={selection?.kind === "attempt" ? selection.id : null} onSelect={(traceId) => onSelect({ kind: "attempt", id: traceId })}
      emptyNote={overview?.executor === "scripted" ? "no model attempts · scripted detectors make no model calls" : "no model attempt recorded yet"} />
    <ArtifactIndex artifacts={artifacts} selectedId={selection?.kind === "artifact" ? selection.id : null} onSelect={(artifactId) => onSelect({ kind: "artifact", id: artifactId })} />
  </div>;
}

/** Every persisted artifact, grouped by the node that recorded it, under readable names. */
function ArtifactIndex({ artifacts, selectedId, onSelect }: { readonly artifacts: readonly ArtifactDescriptor[]; readonly selectedId: string | null; readonly onSelect: (artifactId: string) => void }): ReactElement {
  const groups = new Map<string, ArtifactDescriptor[]>();
  for (const artifact of artifacts) {
    const owner = artifact.nodeId?.split("/")[0] ?? "run";
    groups.set(owner, [...(groups.get(owner) ?? []), artifact]);
  }
  return <section aria-labelledby="artifacts-title" className="section">
    <h2 className="panel-title" id="artifacts-title">recorded artifacts · {artifacts.length}</h2>
    {artifacts.length === 0 ? <p className="state" data-state="unexamined">no artifact recorded yet</p> : [...groups].map(([owner, items]) => <details className="disclosure" key={owner}>
      <summary>{owner} · {items.length}</summary>
      <ul aria-label={`artifacts of ${owner}`} className="plain-list artifact-index">{items.map((artifact) => { const { name, hash } = artifactName(artifact.kind); return <li data-selected={artifact.artifactId === selectedId} key={artifact.artifactId}>
        <button aria-pressed={artifact.artifactId === selectedId} className="link-button" type="button" onClick={() => onSelect(artifact.artifactId)}>{name}{hash === null ? "" : ` · ${hash}`}</button>
        <span className="muted"> {artifact.bytes} bytes{artifact.nodeId == null || artifact.nodeId === owner ? "" : ` · ${shortPath(artifact.nodeId)}`}</span>
      </li>; })}</ul>
    </details>)}
  </section>;
}
