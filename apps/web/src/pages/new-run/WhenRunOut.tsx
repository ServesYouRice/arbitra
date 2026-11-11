import type { ReactElement } from "react";
import { runsThrough } from "./ChangeModels.js";
import type { Draft } from "./draft.js";
import { fallbackChoices, withCostCap, withFallback } from "./fallback.js";

const PAUSE = "pause";
const GO_ON = "other";

/**
 * When a model runs out: per model of the lineup, whether its work pauses the run or goes on with the same model by the
 * other route, and for a model through an API key the dollars it may spend. Observed live (memoria, November 10–11,
 * 2026): Opus through an API key spent its $200 credit before the plan, and the plan went on through Claude Code only
 * by a resume made by hand.
 */
export function WhenRunOut({ draft, setDraft }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void }): ReactElement | null {
  const choices = fallbackChoices(draft);
  if (choices.length === 0) return null;
  return <fieldset className="roles when-run-out"><legend className="panel-title">when a model runs out</legend>
    <div className="field-row">{choices.map((choice) => <div className="field" key={choice.alias}>
      <label className="field">{choice.model} ({choice.alias}) through {runsThrough(choice.transport)}: when it runs out
        <select aria-label={`when ${choice.alias} runs out`} value={choice.fallback === null ? PAUSE : GO_ON} onChange={(event) => setDraft(withFallback(draft, choice.alias, event.target.value === GO_ON))}>
          <option value={PAUSE}>pause the run</option>
          <option value={GO_ON}>go on through {runsThrough(choice.other)}</option>
        </select>
      </label>
      {choice.cappable ? <label className="field">stop at $
        <input aria-label={`dollar cap for ${choice.alias}`} min={1} step={1} type="number" placeholder="no cap" value={choice.capUsd ?? ""}
          onChange={(event) => setDraft(withCostCap(draft, choice.alias, event.target.value === "" ? null : Number(event.target.value)))} />
      </label> : null}
    </div>)}</div>
    <span className="field__hint">An API key runs out when its credit does or at its cap; a CLI when its usage limit resets more than 30 minutes later (a nearer reset is waited for). The work already done is kept, and the run page says when a model switched.</span>
  </fieldset>;
}
