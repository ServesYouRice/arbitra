import { useEffect, useState, type ReactElement } from "react";
import type { RunOverview, RunResource } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { basename, formatTime, isActive } from "../../app/format.js";
import { StateChip } from "../../app/marks.js";
import { Link } from "../../app/router.js";
import { raisedTokenLimit, tokens } from "../../app/token-limit.js";
import { failureWords, type Mode } from "../../app/words.js";
import { modelName, modelProfiles, record } from "./models.js";

const MODE_WORDS: Readonly<Record<Mode, string>> = Object.freeze({ audit: "audit", feature: "feature", testing: "testing" });
const NEW_RUN: Readonly<Record<Mode, string>> = Object.freeze({ audit: "New audit with these settings", feature: "New feature run with these settings", testing: "New testing run with these settings" });

/**
 * The run's project and kind, its state in words, and the one lifecycle action its state allows: cancel a working
 * run, resume a stopped one when resuming can help, raise the token limit of one paused on it, or start a new run
 * like a finished one. A blocked run's decisions are in the banner beneath this, with its resume.
 */
export function RunHeader({ runId, mode, resource, overview, overviewError = null, reason, streamError, files, onChanged }: {
  readonly runId: string;
  readonly mode: Mode;
  readonly resource: RunResource | null;
  readonly overview: RunOverview | null;
  /** Why the run's recorded settings could not be read, when they could not. */
  readonly overviewError?: string | null;
  readonly reason: string | null;
  readonly streamError: string | null;
  /** How much of the project the run read, from its preflight record, once known. */
  readonly files?: { readonly files: number; readonly lines: number | null } | null;
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
  // A working state that this arbitra is not executing: run elsewhere (such as the CLI) or interrupted when its
  // process stopped. Cancel cannot reach it; resume is the way on, and the Summary says why.
  const elsewhere = isActive(state) && overview !== null && !overview.live;
  const helps = state !== "FAILED" || failureWords(reason ?? overview?.reason ?? null).resumable;
  const resumable = resource?.resumable === true && state !== null && helps && (elsewhere || ["CANCELLED", "FAILED", "SUSPENDED_BUDGET", "SUSPENDED_RATE_LIMIT"].includes(state));
  // A run paused on its token budget goes on only with a higher limit; everything it has charged stays charged.
  const limit = record(record(overview?.configuration?.["workflow"])["modelExecution"])["maximumTokens"];
  const [raised, setRaised] = useState(0);
  useEffect(() => { if (typeof limit === "number") setRaised(raisedTokenLimit(limit)); }, [limit]);
  const project = overview?.repository == null ? runId : basename(overview.repository);
  const facts = overview === null ? [] : [`started ${formatTime(overview.createdAt)}`, executorText(overview),
    ...(files == null ? [] : [`${files.files.toLocaleString("en")} files${files.lines === null ? "" : `, ${files.lines.toLocaleString("en")} lines`}`])];
  return <header className="run-header">
    <Link className="run-header__back" to={{ page: "runs" }}>← Runs</Link>
    <div className="run-header__title">
      <h1 className="page-title">{project} · {MODE_WORDS[mode]}</h1>
      <StateChip state={state} />
      <div className="actions">
        {isActive(state) && !elsewhere ? <button className="button" disabled={busy} type="button" onClick={() => { void act(() => runs.cancel(runId)); }}>Cancel</button> : null}
        {resumable && state === "SUSPENDED_BUDGET" && typeof limit === "number" ? <form className="raise-limit" onSubmit={(event) => { event.preventDefault(); void act(() => runs.resume(runId, raised)); }}>
          <label className="field">token limit · now {tokens(limit)}<input aria-label="new token limit" min={limit + 1} step={1_000_000} type="number" value={raised} onChange={(event) => setRaised(Number(event.target.value))} /></label>
          <button className="button button--primary" disabled={busy || !(raised > limit)} type="submit">Raise to {tokens(raised)} and resume</button>
        </form>
          : resumable ? <button className="button button--primary" disabled={busy} type="button" onClick={() => { void act(() => runs.resume(runId)); }}>Resume</button> : null}
        {state === "COMPLETED" ? <Link className="more-link" to={{ page: "new-run", from: `run:${runId}`, graph: null }}>{NEW_RUN[mode]}</Link> : null}
      </div>
    </div>
    {facts.length === 0 ? overviewError === null ? <p className="run-header__meta" role="status">reading the run's settings</p> : null : <p className="run-header__meta">{facts.join(" · ")}</p>}
    {overview === null && overviewError !== null ? <Problem detail={overviewError}>The run's settings could not be read, so its project, models and times are missing here. Reload the page to try again.</Problem> : null}
    {streamError === null ? null : <Problem detail={streamError}>Live updates stopped, so this page may be behind the run. Reload it to see where the run stands.</Problem>}
    {failure === null ? null : <Problem detail={failure}>That did not go through, and the run is as it was. Try again, or reload the page to see where it stands.</Problem>}
  </header>;
}

/** A problem in words first; what the server recorded one click down. */
export function Problem({ detail, children }: { readonly detail: string | null; readonly children: string }): ReactElement {
  return <div className="state problem" data-state="degraded" role="alert">
    <p>{children}</p>
    {detail === null ? null : <details><summary>Details</summary><code>{detail}</code></details>}
  </div>;
}

/** The models that ran the run, by name, or that scripted detectors did. */
export function executorText(overview: RunOverview): string {
  if (overview.executor === "scripted") return "scripted detectors, no model calls";
  const profiles = overview.configuration === null ? [] : modelProfiles(overview.configuration);
  return profiles.length === 0 ? "no models recorded" : [...new Set(profiles.map(({ modelId }) => modelName(modelId)))].join(" · ");
}
