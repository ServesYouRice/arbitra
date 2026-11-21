import type { ReactElement } from "react";
import { runsThrough } from "./ChangeModels.js";
import type { Draft } from "./draft.js";
import { fallbackChoices, withCostCap, withFallback, type FallbackKind } from "./fallback.js";
import type { OfferedModels } from "./model-catalog.js";

const NONE = "pause";

/**
 * When a model runs out: per model of the lineup, whether its work pauses the run (or, for a finder the run can do
 * without, goes on without it), goes on with the same model by the other route, or (a Gemini model through
 * Antigravity) goes on with the Gemini model of Antigravity's other usage limit; for a model through an API key, the
 * dollars it may spend. Observed live (memoria, November 10–11, 2026): Opus through an API key spent its $200 credit
 * before the plan, and the plan went on through Claude Code only by a resume made by hand.
 */
export function WhenRunOut({ draft, setDraft, offered = {} }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly offered?: OfferedModels }): ReactElement | null {
  const choices = fallbackChoices(draft, offered);
  if (choices.length === 0) return null;
  const sameRoute = choices.some((choice) => choice.sameRoute !== null);
  return <fieldset className="roles when-run-out"><legend className="panel-title">when a model runs out</legend>
    <div className="field-row">{choices.map((choice) => <div className="field" key={choice.alias}>
      <label className="field">{choice.model} ({choice.alias}) through {runsThrough(choice.transport)}: when it runs out
        <select aria-label={`when ${choice.alias} runs out`} value={choice.kind ?? NONE}
          onChange={(event) => setDraft(withFallback(draft, choice.alias, event.target.value === NONE ? false : event.target.value as FallbackKind, offered))}>
          <option value={NONE}>{choice.optional ? "go on without it" : "pause the run"}</option>
          {choice.other === null ? null : <option value="route">go on through {runsThrough(choice.other)}</option>}
          {choice.sameRoute === null ? null : <option value="model">go on with {choice.sameRoute.model}</option>}
        </select>
      </label>
      {choice.cappable ? <label className="field">stop at $
        <input aria-label={`dollar cap for ${choice.alias}`} min={1} step={1} type="number" placeholder="no cap" value={choice.capUsd ?? ""}
          onChange={(event) => setDraft(withCostCap(draft, choice.alias, event.target.value === "" ? null : Number(event.target.value)))} />
      </label> : null}
    </div>)}</div>
    <span className="field__hint">An API key runs out when its credit does or at its cap; a CLI when its usage limit resets more than 30 minutes later (a nearer reset is waited for). The work already done is kept, and the run page says when a model switched.{sameRoute ? " Antigravity's limits are per model: Gemini 4 Argon has a weekly limit of its own, the other Gemini models share theirs, so one can go on when the other is out." : ""}</span>
  </fieldset>;
}
