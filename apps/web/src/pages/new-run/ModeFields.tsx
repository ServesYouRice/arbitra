import type { ReactElement } from "react";
import { getIn, type Draft, type Edit } from "./draft.js";

/** What a Feature run plans: the request in the person's words, and who decides its high-impact defaults. */
export function FeatureFields({ draft, edit }: { readonly draft: Draft; readonly edit: Edit }): ReactElement {
  const decision = String(getIn(draft, ["workflow", "feature", "mode"]) ?? "interactive");
  return <>
    <label className="field">feature request<textarea aria-label="feature request" rows={4} value={String(getIn(draft, ["workflow", "feature", "request"]) ?? "")} onChange={(event) => edit(["workflow", "feature", "request"], event.target.value)} /></label>
    <p className="field__hint">What to build, in your words. A model turns it into requirements you can read before the plan.</p>
    <div className="field-row">
      <label className="field">defaults
        <select aria-label="defaults" value={decision} onChange={(event) => edit(["workflow", "feature", "mode"], event.target.value)}><option value="interactive">ask me before a high-impact default</option><option value="automatic">accept the proposed defaults</option></select>
      </label>
      <label className="field">requirement revisions<input aria-label="requirement revisions" max={3} min={0} type="number" value={Number(getIn(draft, ["workflow", "feature", "maximumRequirementsRevisions"]) ?? 1)} onChange={(event) => edit(["workflow", "feature", "maximumRequirementsRevisions"], Number(event.target.value))} /></label>
    </div>
  </>;
}

/** What a Testing run protects, and whether it only plans tests or writes and runs them. */
export function TestingFields({ draft, edit }: { readonly draft: Draft; readonly edit: Edit }): ReactElement {
  const execute = getIn(draft, ["workflow", "testing", "mode"]) === "execute";
  return <>
    <label className="field">testing goal<textarea aria-label="testing goal" rows={3} value={String(getIn(draft, ["workflow", "testing", "goal"]) ?? "")} onChange={(event) => edit(["workflow", "testing", "goal"], event.target.value)} /></label>
    <p className="field__hint">The behaviour the new tests must protect.</p>
    <p className="state" data-state={execute ? "attention" : "unexamined"}>{execute ? "Writes and runs tests in a Docker sandbox, under the write grants and checks in the lineup's JSON; the project itself is never changed." : "Plans tests only; nothing is written or run."}</p>
  </>;
}
