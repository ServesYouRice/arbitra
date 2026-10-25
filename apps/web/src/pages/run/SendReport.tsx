import { useState, type ReactElement } from "react";
import { reportText } from "./RunReport.js";

/** Where a run's report goes: a new issue on arbitra's repository, which the person submits from their GitHub account. */
export const ISSUES_NEW = "https://github.com/ServesYouRice/arbitra/issues/new";
/** GitHub refuses addresses much longer than this; a longer report is cut at a line, and copied whole. */
const LINK_LIMIT = 7_500;
const KEY = "arbitra.send-reports";

export type ReportOccasion = "the plan was saved" | "the run failed" | "the run finished";

/** The issue's address: the report as its body, cut to fit a link (`cut`), and the title naming the build. */
export function issueLink(report: string, occasion: ReportOccasion): { readonly url: string; readonly cut: boolean } {
  const build = /^build (.+)$/mu.exec(report)?.[1] ?? "build not recorded";
  const link = (text: string, cut: boolean): string => `${ISSUES_NEW}?title=${encodeURIComponent(`Run report: ${occasion} (${build})`)}&body=${encodeURIComponent(issueBody(text, cut))}`;
  if (link(report, false).length <= LINK_LIMIT) return { url: link(report, false), cut: false };
  const lines = report.split("\n");
  while (lines.length > 1 && link(lines.join("\n"), true).length > LINK_LIMIT) lines.pop();
  let kept = lines.join("\n");
  while (kept.length > 0 && link(kept, true).length > LINK_LIMIT) kept = kept.slice(0, -80);
  return { url: link(kept, true), cut: true };
}

function issueBody(report: string, cut: boolean): string {
  return ["What were you doing, and what did you expect? (optional)", "", "", "```text", report, "```",
    ...(cut ? ["", "The report was cut here to fit a link. The whole report was copied: paste it below."] : [])].join("\n");
}

function agreed(): boolean {
  try { return window.localStorage.getItem(KEY) === "on"; } catch { return false; }
}

/** Whether the person agreed to send reports, and a setter kept in this browser (storage that cannot be read reads as no). */
export function useSendChoice(): readonly [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(agreed);
  const choose = (next: boolean): void => { try { window.localStorage.setItem(KEY, next ? "on" : "off"); } catch { /* the choice lasts for this page only */ } setOn(next); };
  return [on, choose];
}

/**
 * A tab opened at the click, so no pop-up blocker stops it, and pointed at the issue once the report is read. A report
 * cut to fit the link is also copied whole, to paste under it.
 */
export function reportTab(): { readonly send: (runId: string, occasion: ReportOccasion, text?: string) => Promise<void>; readonly cancel: () => void } {
  const tab = window.open("", "_blank");
  if (tab !== null) tab.opener = null;
  return {
    send: async (runId, occasion, text) => {
      try {
        const report = text ?? await reportText(runId);
        const { url, cut } = issueLink(report, occasion);
        if (cut) await (navigator.clipboard as Clipboard | undefined)?.writeText(report).catch(() => undefined);
        if (tab === null) window.open(url, "_blank", "noopener"); else tab.location.href = url;
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    cancel: () => tab?.close(),
  };
}

const failed = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * "Send to the developer": the run's report as a filled-in GitHub issue. Nothing leaves the computer until the person
 * submits it there. The first time, the exact text and where it goes are shown before anything opens; once agreed, the
 * choice is kept in this browser, the button opens the issue at once, and saving a plan sends its report too (PlanCard).
 */
export function SendReport({ runId, occasion, className = "link-button more-link" }: { readonly runId: string; readonly occasion: ReportOccasion; readonly className?: string }): ReactElement {
  const [on, choose] = useSendChoice();
  const [shown, setShown] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const send = (text?: string): void => { void reportTab().send(runId, occasion, text).catch((error: unknown) => setFailure(failed(error))); };
  const click = (): void => {
    setFailure(null);
    if (on) { send(); return; }
    void reportText(runId).then(setShown, (error: unknown) => setFailure(failed(error)));
  };
  return <>
    <button className={className} type="button" onClick={click}>Send to the developer</button>
    {shown === null ? null : <ReportPreview text={shown} action="Open the issue on GitHub" onAgree={() => { choose(true); setShown(null); send(shown); }} onCancel={() => setShown(null)} />}
    {failure === null ? null : <p className="state send-report" data-state="degraded" role="alert">The report could not be sent: {failure}</p>}
  </>;
}

/** What a report holds and where it goes, with its exact text, before the person agrees. */
export function ReportPreview({ text, action, onAgree, onCancel }: { readonly text: string; readonly action: string; readonly onAgree: () => void; readonly onCancel: () => void }): ReactElement {
  return <div aria-label="the report to send" className="send-report" role="group">
    <p className="prose">This opens a new issue at github.com/ServesYouRice/arbitra with the text below, for you to submit from your GitHub account. Issues there are public. The text holds no source code and no secrets; it names the folders and files the run was set to read or leave out.</p>
    <textarea aria-label="report text" className="run-report__text" readOnly rows={10} value={text} />
    <div className="actions">
      <button className="button button--primary" type="button" onClick={onAgree}>{action}</button>
      <button className="button" type="button" onClick={onCancel}>Not now</button>
    </div>
    <p className="note">From then on, Send to the developer opens the issue at once, and saving a plan sends its report too. The box under the Save button turns it off.</p>
  </div>;
}
