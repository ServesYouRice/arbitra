import { useState, type ReactElement } from "react";
import type { RunOverview } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { useNavigation } from "../../app/router.js";
import { changedFiles, counted, failureWords, type Mode } from "../../app/words.js";

/** Whether a new audit can reuse what this run finished: a model Audit that ran its own discovery, not a replay of another's. */
export function reusesFinishedWork(mode: Mode, overview: RunOverview | null): boolean {
  return mode === "audit" && overview?.executor === "models" && overview.replayOf === null;
}

/**
 * A run whose project's files changed after it read them, so it cannot resume: which files changed, and for a model
 * Audit a new audit of the project as it is now that reuses what the run finished (an incremental audit with the run as
 * its base and the run's own settings). `framed` sets it apart as a problem with its details, as the header shows a
 * refused resume; unframed it sits in the Summary's note on a failed run, which has its own. Observed live (October 27,
 * 2026, v0.3.1, macOS): a ten-hour audit failed, five files in its scope were edited the next morning, and the page
 * said only to put them back or start again, without naming them.
 */
export function RepositoryChanged({ runId, mode, detail, reuse, framed = true }: { readonly runId: string; readonly mode: Mode; readonly detail: string; readonly reuse: boolean; readonly framed?: boolean }): ReactElement {
  const { runs } = useApis();
  const { navigate } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const words = failureWords(detail, mode);
  const changed = changedFiles(detail);
  const start = async (): Promise<void> => {
    setBusy(true); setFailure(null);
    try { const run = await runs.startIncremental(runId); navigate({ page: "run", runId: run.runId, tab: null, item: null }); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const content = <>
    <p className="prose">{words.what}</p>
    {changed === null ? null : <>
      <p className="prose">{counted(changed.total, "file")} changed since the run read them:</p>
      <ul aria-label="files changed since the run read them" className="plain-list">{changed.files.map(({ path, change }) => <li key={`${change}:${path}`}><span className="data">{path}</span> <span className="muted">· {change}</span></li>)}</ul>
      {changed.more > 0 ? <p className="note">and {counted(changed.more, "more file", "more files")}</p> : null}
    </>}
    <p className="prose">{reuse ? "Put the files back as they were to resume, or start a new audit of the project as it is now. It reuses the parts this run finished whose files did not change and reads the rest again; merging duplicates, checking each issue and writing the plan run again in full." : words.todo}</p>
    {reuse ? <div className="actions"><button className="button" disabled={busy} type="button" onClick={() => { void start(); }}>New audit that reuses what this run finished</button></div> : null}
    {failure === null ? null : <p className="state" data-state="degraded">The new audit did not start ({failure}). Try again, or start one from New run.</p>}
  </>;
  return framed ? <div aria-label="The project's files changed" className="state problem" data-state="degraded" role="alert">
    {content}
    <details><summary>Details</summary><code>{detail}</code></details>
  </div> : content;
}
