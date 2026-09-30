import { useState, type ReactElement } from "react";
import type { RunOverview, RunResource } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { formatTime, isActive, MODE_LABELS } from "../../app/format.js";
import { GateVerdict, StateChip } from "../../app/marks.js";
import { Link } from "../../app/router.js";

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
  const workflowId = resource?.workflow?.id ?? overview?.workflowId ?? null;
  const absent = overviewError === null ? "loading" : "unavailable";
  return <header className="run-header">
    <Link className="run-header__back" to={{ page: "runs" }}>all runs</Link>
    <div className="run-header__title">
      <h1 className="page-title">{MODE_LABELS[mode]} run{workflowId === null ? "" : ` · ${workflowId}`}</h1>
      <StateChip state={state} />
      <div className="actions">
        {isActive(state) && !elsewhere ? <button className="button" disabled={busy} type="button" onClick={() => { void act(() => runs.cancel(runId)); }}>cancel run</button> : null}
        {resumable ? <button className="button button--primary" disabled={busy} type="button" onClick={() => { void act(() => runs.resume(runId)); }}>resume run</button> : null}
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
  const models = overview.configuration?.["models"];
  const count = typeof models === "object" && models !== null ? Object.keys(models).length : 0;
  return count === 1 ? "1 model profile" : `${count} model profiles`;
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
