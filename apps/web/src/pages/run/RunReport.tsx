import { useEffect, useState, type ReactElement } from "react";
import { CopyButton } from "../../controls/CopyButton.js";

/**
 * The run's plain-text report, for a tester to copy and send: build, machine, models found, settings, each stage's calls
 * and every failed call, with the recorded codes. Read when asked for, so it reflects the run as it is then; it holds
 * no source code.
 */
export async function reportText(runId: string): Promise<string> {
  const response = await fetch(`/diagnostics/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw new Error(`The report could not be read (HTTP ${response.status}).`);
  return await response.text();
}

/** The report to read on the page, and to copy. */
export function RunReport({ runId }: { readonly runId: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setText(null);
    void reportText(runId).then(setText, (error: unknown) => setText(error instanceof Error ? error.message : String(error)));
  }, [open, runId]);
  return <details className="disclosure run-report" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>Read the report to send</summary>
    {text === null ? <p className="note">reading the run</p> : <>
      <textarea aria-label="run report" className="run-report__text" readOnly rows={14} value={text} onFocus={(event) => event.currentTarget.select()} />
      <CopyButton label="Copy the report" text={text} />
    </>}
  </details>;
}
