import type { ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import type { RunOverview, RunResource } from "../../api/runs.js";
import type { RunEvent } from "../../api/sse.js";
import { useApis } from "../../app/apis.js";
import { artifactName, shortPath } from "../../app/format.js";
import { GraphView } from "../../graph/GraphView.js";
import { TraceView } from "../../views/traces/TraceView.js";
import type { Selection } from "./selection.js";

/**
 * What the run did, step by step: the executed graph with each node's status, every
 * recorded model attempt, and every persisted artifact. Each opens in the details panel.
 */
export function ActivityTab({ runId, run, events, artifacts, overview, selection, onSelect }: {
  readonly runId: string;
  readonly run: RunResource | null;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly overview: RunOverview | null;
  readonly selection: Selection | null;
  readonly onSelect: (selection: Selection) => void;
}): ReactElement {
  const { traces } = useApis();
  return <div className="activity">
    {run?.workflow === undefined ? <p className="state" data-state="unexamined">{run === null ? "reading the run" : "no workflow recorded for this run"}</p>
      : <GraphView workflowJson={run.workflow} runEvents={events} artifacts={artifacts} selectedNodeId={selection?.kind === "node" ? selection.id : null} onSelect={(node) => onSelect({ kind: "node", id: node.id })} {...(run.workflowGraph === undefined ? {} : { identity: run.workflowGraph })} />}
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
