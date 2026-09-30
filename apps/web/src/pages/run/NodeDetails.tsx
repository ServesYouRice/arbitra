import { NODE_GLYPHS } from "@arbitra/schemas/glyphs";
import type { ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import type { RunOverview } from "../../api/runs.js";
import { useLoaded } from "../../api/runs.js";
import type { RunEvent } from "../../api/sse.js";
import { useApis } from "../../app/apis.js";
import { artifactName, shortPath } from "../../app/format.js";
import { NODE_KIND_LABELS, projectLiveState, statusText, type WorkflowNode } from "../../graph/GraphView.js";
import { isRecordedStage } from "../../graph/recorded-stages.js";
import { measured } from "../../views/evaluation/api.js";
import type { Selection } from "./selection.js";
import { modelProfiles, type ModelProfileSummary } from "./models.js";

/**
 * Everything the run recorded about one node: its status, the model bound to it, its model
 * attempts, the prompts it compiled and the artifacts it wrote. Nothing is inferred from
 * the current configuration editor; a scripted auditor says it made no model call.
 */
export function NodeDetails({ runId, node, overview, events, artifacts, onSelect }: {
  readonly runId: string;
  readonly node: WorkflowNode;
  readonly overview: RunOverview | null;
  readonly events: readonly RunEvent[];
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly onSelect: (selection: Selection) => void;
}): ReactElement {
  const { traces } = useApis();
  const stage = isRecordedStage(node);
  const parentId = typeof node.config?.["parentId"] === "string" ? node.config["parentId"] : null;
  // Model activity is traced against the top-level node; a recorded stage shares its subgraph's.
  const traceNode = stage ? parentId : node.id;
  const live = projectLiveState({ id: "node", nodes: [node], edges: [] }, events).get(node.id);
  const attempts = useLoaded(traceNode === null ? null : `${runId}:${traceNode}`, () => traces.list(runId, { nodeId: traceNode ?? "" }, 0), events.length);
  const owned = artifacts.filter((artifact) => ownsArtifact(node, artifact));
  const prompts = owned.filter(({ kind }) => kind.startsWith("compiled-prompt"));
  const written = owned.filter(({ kind }) => !kind.startsWith("compiled-prompt"));
  const scripted = overview?.executor === "scripted";
  const profiles = overview?.configuration == null ? [] : modelProfiles(overview.configuration).filter(({ alias, roles }) => alias === node.id || roles.some((role) => role.node === (parentId ?? node.id)));
  const config = Object.fromEntries(Object.entries(node.config ?? {}).filter(([key]) => !["recordedStage", "parentId", "artifactKinds"].includes(key)));
  return <div className="details-stack">
    <p className="details__kind"><span aria-hidden="true" style={{ color: `var(${NODE_GLYPHS[node.kind].token})` }}>{NODE_GLYPHS[node.kind].glyph}</span> {NODE_KIND_LABELS[node.kind]}{stage && parentId !== null ? ` · recorded stage of ${parentId}` : ""}</p>
    <dl className="facts">
      <div><dt>node</dt><dd><code>{node.id}</code></dd></div>
      <div><dt>status</dt><dd>{live === undefined ? "unavailable" : statusText(live)}</dd></div>
    </dl>
    {node.kind === "model" && scripted ? <p className="state" data-state="unexamined">scripted detector · this node makes no model call</p> : null}
    {profiles.length === 0 ? null : <section className="details-section" aria-label="bound models">
      <h3 className="panel-title">bound models</h3>
      <ModelTable compact profiles={profiles} />
    </section>}
    {traceNode === null || scripted ? null : <section className="details-section" aria-label="model attempts">
      <h3 className="panel-title">model attempts{stage ? ` · recorded for ${traceNode}` : ""}</h3>
      {attempts.error !== null ? <p className="state" data-state="degraded">attempts unavailable · {attempts.error}</p>
        : attempts.value === null ? <p role="status">loading attempts</p>
        : attempts.value.entries.length === 0 ? <p className="state" data-state="unexamined">no model attempt recorded for this node</p>
        : <ul className="plain-list">{attempts.value.entries.map(({ traceId, trace }) => <li key={traceId}>
          <button aria-label={`${trace.activityId} · attempt ${trace.attempt}`} className="link-button" title={trace.activityId} type="button" onClick={() => onSelect({ kind: "attempt", id: traceId })}>{shortPath(trace.activityId)} · attempt {trace.attempt}</button>
          <span className="muted"> {trace.modelId} · {trace.outcome} · {measured(trace.durationMs, "ms")}</span>
        </li>)}{attempts.value.total > attempts.value.entries.length ? <li className="note">{attempts.value.total - attempts.value.entries.length} more in the Activity tab</li> : null}</ul>}
    </section>}
    {prompts.length === 0 ? null : <ArtifactList title="compiled prompts" artifacts={prompts} onSelect={onSelect} />}
    {written.length === 0 ? (stage ? null : <p className="state" data-state="unexamined">no artifact recorded for this node</p>) : <ArtifactList title="recorded artifacts" artifacts={written} onSelect={onSelect} />}
    {Object.keys(config).length === 0 ? null : <section className="details-section" aria-label="node configuration">
      <h3 className="panel-title">configuration</h3>
      <pre className="artifact__content">{JSON.stringify(config, null, 2)}</pre>
    </section>}
  </div>;
}

export function ModelTable({ profiles, compact = false }: { readonly profiles: readonly ModelProfileSummary[]; readonly compact?: boolean }): ReactElement {
  // A side panel is too narrow for four columns; each profile becomes one line there.
  if (compact) return <ul className="plain-list">{profiles.map((profile) => <li key={profile.alias}><strong>{profile.alias}</strong> <span className="muted">· {profile.provider} · {profile.modelId} · {profile.transport}{profile.roles.length === 0 ? "" : ` · ${profile.roles.map(({ label }) => label).join(", ")}`}</span></li>)}</ul>;
  return <div className="table-scroll"><table aria-label="model profiles" className="table">
    <thead><tr><th scope="col">profile</th><th scope="col">provider · model</th><th scope="col">transport</th><th scope="col">roles</th></tr></thead>
    <tbody>{profiles.map((profile) => <tr key={profile.alias}>
      <td>{profile.alias}</td>
      <td>{profile.provider} · {profile.modelId}</td>
      <td>{profile.transport}</td>
      <td>{profile.roles.map(({ label }) => label).join(", ") || "none"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function ArtifactList({ title, artifacts, onSelect }: { readonly title: string; readonly artifacts: readonly ArtifactDescriptor[]; readonly onSelect: (selection: Selection) => void }): ReactElement {
  return <section className="details-section" aria-label={title}>
    <h3 className="panel-title">{title}</h3>
    <ul className="plain-list">{artifacts.map((artifact) => { const { name, hash } = artifactName(artifact.kind); return <li key={artifact.artifactId}>
      <button className="link-button" type="button" onClick={() => onSelect({ kind: "artifact", id: artifact.artifactId })}>{name}{hash === null ? "" : ` · ${hash}`}</button>
      <span className="muted"> {artifact.bytes} bytes{artifact.nodeId == null ? "" : ` · ${shortPath(artifact.nodeId)}`}</span>
    </li>; })}</ul>
  </section>;
}

/**
 * An artifact belongs to a node when it was recorded against it or one of its activities
 * (`feature/requirements`). A recorded stage owns the artifact kinds it was expanded from.
 */
function ownsArtifact(node: WorkflowNode, artifact: ArtifactDescriptor): boolean {
  if (isRecordedStage(node)) {
    const kinds = node.config?.["artifactKinds"];
    return Array.isArray(kinds) && kinds.includes(artifact.kind);
  }
  const owner = artifact.nodeId ?? null;
  return owner !== null && (owner === node.id || owner.startsWith(`${node.id}/`));
}
