import { useEffect, useState, type ReactElement } from "react";
import type { RunOverview, RunResource } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { formatTime, isActive, MODE_LABELS } from "../../app/format.js";
import { GateVerdict, StateChip } from "../../app/marks.js";
import { Link } from "../../app/router.js";
import { raisedTokenLimit, tokens } from "../../app/token-limit.js";
import { modelName, modelProfiles, record } from "./models.js";

/**
 * Who, what and where for one run, and the single lifecycle action its state allows. A
 * blocked run's decisions live in the banner beneath this, not here.
 */
export function RunHeader({ runId, mode, resource, overview, overviewError = null, reason, streamError, onChanged }: {
  readonly runId: string;
  readonly mode: "audit" | "feature" | "testing";
  readonly resource: RunResource | null;
  readonly overview: RunOverview | null;
  /** Why the run's recorded settings could not be read, when they could not. */
  readonly overviewError?: string | null;
  readonly reason: string | null;
  readonly streamError: string | null;
  readonly onChanged: () => void;
}): ReactElement {
  const { runs } = useApis();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const state = resource?.state ?? overview?.state ?? null;
  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setFailure(null);
    try { await operation(); onChanged(); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  // A running state that this control plane is not executing: run elsewhere (such as the CLI)
  // or interrupted when its process stopped. Cancel cannot reach it; resume is the way on.
  const elsewhere = isActive(state) && overview !== null && !overview.live;
  const resumable = resource?.resumable === true && state !== null && (elsewhere || ["CANCELLED", "FAILED", "SUSPENDED_BUDGET", "SUSPENDED_RATE_LIMIT"].includes(state));
  // A run paused on its token budget goes on only with a higher limit; everything it has charged stays charged.
  const limit = record(record(overview?.configuration?.["workflow"])["modelExecution"])["maximumTokens"];
  const [raised, setRaised] = useState(0);
  useEffect(() => { if (typeof limit === "number") setRaised(raisedTokenLimit(limit)); }, [limit]);
  const workflowId = resource?.workflow?.id ?? overview?.workflowId ?? null;
  const absent = overviewError === null ? "loading" : "unavailable";
  return <header className="run-header">
    <Link className="run-header__back" to={{ page: "runs" }}>all runs</Link>
    <div className="run-header__title">
      <h1 className="page-title">{MODE_LABELS[mode]} run{workflowId === null ? "" : ` · ${workflowId}`}</h1>
      <StateChip state={state} live={overview?.live === true} />
      <div className="actions">
        {isActive(state) && !elsewhere ? <button className="button" disabled={busy} type="button" onClick={() => { void act(() => runs.cancel(runId)); }}>cancel run</button> : null}
        {resumable && state === "SUSPENDED_BUDGET" && typeof limit === "number" ? <form className="raise-limit" onSubmit={(event) => { event.preventDefault(); void act(() => runs.resume(runId, raised)); }}>
          <label className="field">token limit · now {tokens(limit)}<input aria-label="new token limit" min={limit + 1} step={1_000_000} type="number" value={raised} onChange={(event) => setRaised(Number(event.target.value))} /></label>
          <button className="button button--primary" disabled={busy || !(raised > limit)} type="submit">raise to {tokens(raised)} and resume</button>
        </form>
          : resumable ? <button className="button button--primary" disabled={busy} type="button" onClick={() => { void act(() => runs.resume(runId)); }}>resume run</button> : null}
        {state === "COMPLETED" ? <Link className="button" to={{ page: "new-run", from: `run:${runId}`, graph: null }}>new run with these settings</Link> : null}
      </div>
    </div>
    <dl className="run-header__meta">
      <div><dt>run</dt><dd><code>{runId}</code> <CopyButton text={runId} /></dd></div>
      <div><dt>repository</dt><dd>{overview === null ? absent : overview.repository ?? "not recorded"}</dd></div>
      <div><dt>started</dt><dd>{overview === null ? absent : formatTime(overview.createdAt)}</dd></div>
      <div><dt>last activity</dt><dd>{overview === null ? absent : formatTime(overview.updatedAt)}</dd></div>
      <div><dt>executed by</dt><dd>{overview === null ? absent : executorText(overview)}</dd></div>
    </dl>
    <RunReport runId={runId} />
    {state === "FAILED" ? <p className="state" data-state="refuted">failed · {reason ?? overview?.reason ?? "no reason recorded"}</p> : null}
    {elsewhere ? <p className="state" data-state="degraded">This control plane is not executing this run. Another arbitra process, such as the CLI, may be running it, or it stopped when its process did. Resume it only if nothing else is running it.</p> : null}
    {overview?.gate == null ? null : <GateVerdict gate={overview.gate} compact />}
    {overview === null && overviewError !== null ? <p className="state" data-state="degraded" role="alert">run settings unavailable · {overviewError}</p> : null}
    {streamError === null ? null : <p className="state" data-state="degraded" role="alert">live updates unavailable · {streamError}</p>}
    {failure === null ? null : <p className="state" data-state="degraded" role="alert">{failure}</p>}
  </header>;
}

export function executorText(overview: RunOverview): string {
  if (overview.executor === "scripted") return "scripted detectors · no model calls · a smoke test, not a model audit";
  const profiles = overview.configuration === null ? [] : modelProfiles(overview.configuration);
  return profiles.length === 0 ? "no model profiles" : [...new Set(profiles.map(({ modelId }) => modelName(modelId)))].join(" · ");
}

/**
 * The run's plain-text report, for a tester to copy and send: build, machine, models found, settings, each stage's
 * calls and every failed call. Read when opened, so it reflects the run as it is then; it holds no source code.
 */
function RunReport({ runId }: { readonly runId: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setText(null);
    void fetch(`/diagnostics/runs/${encodeURIComponent(runId)}`).then(async (response) => setText(response.ok ? await response.text() : `report unavailable · HTTP ${response.status}`), (error: unknown) => setText(`report unavailable · ${String(error)}`));
  }, [open, runId]);
  return <details className="run-report" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>report to send · copy it and send it to whoever helps you</summary>
    {text === null ? <p className="state" data-state="unexamined">reading the run</p> : <>
      <textarea aria-label="run report" className="run-report__text" readOnly rows={14} value={text} onFocus={(event) => event.currentTarget.select()} />
      <CopyButton text={text} />
    </>}
  </details>;
}

function CopyButton({ text }: { readonly text: string }): ReactElement {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = (): void => {
    // The clipboard exists only in a secure context; localhost is one, other hosts may not be.
    const clipboard = typeof navigator === "undefined" ? undefined : (navigator.clipboard as Clipboard | undefined);
    if (clipboard === undefined) setCopied(false);
    else void clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false));
    setTimeout(() => setCopied(null), 2_000);
  };
  return <button aria-label="copy run id" className="link-button" type="button" onClick={copy}>{copied === null ? "copy" : copied ? "copied" : "copy failed"}</button>;
}
