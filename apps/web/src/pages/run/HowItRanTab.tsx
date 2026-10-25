import type { ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import { useNow, type Loaded, type RunOverview, type RunProgress, type RunResource } from "../../api/runs.js";
import type { RunEvent } from "../../api/sse.js";
import { useApis } from "../../app/apis.js";
import { formatTime, gateReasonLabel, isActive } from "../../app/format.js";
import { Link } from "../../app/router.js";
import type { Mode } from "../../app/words.js";
import { CopyButton } from "../../controls/CopyButton.js";
import { useEvaluationMetrics } from "../../views/evaluation/api.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact } from "../../views/issue-board/run-artifacts.js";
import { stageNotes, stepModels, type CritiqueRecord, type PreflightRecord } from "./facts.js";
import { modelProfiles } from "./models.js";
import { ModelTable } from "./NodeDetails.js";
import { executorText } from "./RunHeader.js";
import { RunReport } from "./RunReport.js";
import { StageGraph, stageViews } from "./StageGraph.js";
import { RanFacts } from "./SummaryTab.js";

/**
 * How the run went, in full: time and tokens, the model and effort of each step, every stage with its time, the
 * settings it ran with, the report to send, and, one click down, its records. Recorded codes are here, in the details.
 */
export function HowItRanTab({ runId, mode, run, overview, progress, events, artifacts, refreshKey, selectedNode, onSelectNode }: {
  readonly runId: string; readonly mode: Mode; readonly run: RunResource | null; readonly overview: RunOverview | null; readonly progress: Loaded<RunProgress>;
  readonly events: readonly RunEvent[]; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown; readonly selectedNode: string | null; readonly onSelectNode: (id: string) => void;
}): ReactElement {
  const { artifacts: api, evaluation } = useApis();
  const state = run?.state ?? overview?.state ?? null;
  const now = useNow(isActive(state) && overview?.live === true);
  const done = state === "COMPLETED" && mode === "audit";
  const metrics = useEvaluationMetrics(evaluation, done ? runId : null);
  const preflight = useRunArtifact<PreflightRecord>(api, artifacts.some(({ kind }) => kind === "preflight") ? runId : null, "preflight", refreshKey).value;
  const critique = useRunArtifact<CritiqueRecord>(api, artifacts.some(({ kind }) => kind === RUN_ARTIFACT_KINDS.criticFeedback) ? runId : null, RUN_ARTIFACT_KINDS.criticFeedback, refreshKey).value;
  const workflow = run?.workflow ?? null;
  const stages = workflow === null ? null : stageViews({ workflow, mode, progress: progress.value, events, now, models: stepModels(overview), notes: stageNotes({ workflow, progress: progress.value, preflight, critique }) });
  if (overview === null) return <p role="status">reading the run's settings</p>;
  const profiles = overview.configuration === null ? [] : modelProfiles(overview.configuration);
  const scope = Object.entries(overview.scope).filter(([key]) => key !== "kind").map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(", ") : String(value)}`).join(" · ");
  return <div className="summary how-it-ran">
    <RanFacts runId={runId} mode={mode} overview={overview} progress={progress.value} confirmed={metrics.metrics?.confirmedYield ?? null} critique={critique} workflow={workflow} full />
    {stages === null || workflow === null ? null : <section aria-labelledby="how-stages-title" className="summary-section">
      <h2 className="panel-title" id="how-stages-title">Stages</h2>
      <StageGraph stages={stages} workflow={workflow} selectedId={selectedNode} onSelect={onSelectNode} />
      {progress.value !== null && progress.value.run.elapsedMs === null ? <p className="note">This run was recorded before arbitra kept the time of each stage, so the stages show no times.</p> : null}
    </section>}
    <section aria-labelledby="settings-title" className="summary-section">
      <h2 className="panel-title" id="settings-title">What it read and how</h2>
      <dl className="facts">
        <div><dt>project</dt><dd>{overview.repository ?? "not recorded"}{preflight?.fileCount === undefined ? "" : ` · ${preflight.fileCount.toLocaleString("en")} files${preflight.lineCount === undefined ? "" : `, ${preflight.lineCount.toLocaleString("en")} lines`}`}</dd></div>
        <div><dt>what it read</dt><dd>{overview.scope.kind === "repository" ? "the whole project" : overview.scope.kind}{scope === "" ? "" : ` · ${scope}`}</dd></div>
        <div><dt>models</dt><dd>{executorText(overview)}</dd></div>
        {overview.mode === "audit" ? <div><dt>review rounds</dt><dd>{overview.maximumRounds === 0 ? "none: each issue goes straight to its check" : `up to ${overview.maximumRounds} (${overview.consensusPolicy.replace("_", "-")} review)`}</dd></div> : null}
        <div><dt>ask me before</dt><dd>{overview.checkpointMode === null ? "nothing: this run asks no one" : overview.checkpointMode === "interactive" ? "each checkpoint" : "nothing: checkpoints decide by themselves"}</dd></div>
        <div><dt>started</dt><dd>{formatTime(overview.createdAt)} · last record {formatTime(overview.updatedAt)}</dd></div>
        {overview.workflowGraph === null ? null : <div><dt>saved graph</dt><dd>{overview.workflowGraph.id} @ {overview.workflowGraph.version}</dd></div>}
        {overview.replayOf === null ? null : <div><dt>replay of</dt><dd><Link to={{ page: "run", runId: overview.replayOf, tab: null, item: null }}>{overview.replayOf}</Link></dd></div>}
      </dl>
    </section>
    <section aria-labelledby="records-title" className="summary-section">
      <h2 className="panel-title" id="records-title">Records</h2>
      <ul className="plain-list">
        <li><Link to={{ page: "run", runId, tab: "activity", item: null }}>Activity</Link> <span className="muted">· the executed graph, every model call and every recorded artifact</span></li>
        <li><Link to={{ page: "run", runId, tab: "evaluation", item: null }}>Evaluation</Link> <span className="muted">· what was checked against the source, per model, and the research measures</span></li>
      </ul>
      <RunReport runId={runId} />
      <details className="disclosure">
        <summary>Recorded codes</summary>
        <dl className="facts">
          <div><dt>run</dt><dd><code>{runId}</code> <CopyButton className="link-button" label="Copy the run's ID" text={runId} /></dd></div>
          <div><dt>state</dt><dd><code>{state ?? "unreadable"}</code>{overview.reason === null ? "" : <> · <code>{overview.reason}</code></>}</dd></div>
          <div><dt>workflow</dt><dd><code>{overview.workflowId ?? "not recorded"}</code></dd></div>
          {overview.gate === null ? null : <div><dt>gate</dt><dd>{overview.gate.status} · {overview.gate.reasons.length === 0 ? "no reason" : overview.gate.reasons.map((code) => <span className="gate-code" key={code}>{gateReasonLabel(code)} <code>{code}</code></span>)}</dd></div>}
        </dl>
      </details>
      {profiles.length === 0 ? null : <details className="disclosure"><summary>Model profiles</summary><ModelTable profiles={profiles} /></details>}
      {overview.configuration === null ? null : <details className="disclosure"><summary>Stored configuration · JSON</summary><pre className="artifact__content">{JSON.stringify(overview.configuration, null, 2)}</pre></details>}
    </section>
  </div>;
}
