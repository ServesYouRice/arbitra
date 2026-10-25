import type { ReactElement, ReactNode } from "react";
import { stableJson } from "../../graph/editor-model.js";
import { DEPTHS, findersOf, isSubscriptionAudit, withDepth, withFinders, type Depth } from "./depth.js";
import { getIn, setIn, type Draft } from "./draft.js";
import { lineupRows, stepsOf, type StepState } from "./lineup.js";
import { usage, usageWords } from "./usage.js";

/** Each depth in a few words: what it is, and when to choose it. The models and efforts are read from the draft. */
const CARDS: Readonly<Record<Depth, { readonly name: string; readonly when: string }>> = Object.freeze({
  deep: { name: "Deep", when: "The strongest models at full effort: the lineup the measured runs used." },
  balanced: { name: "Balanced", when: "The same models at medium effort, with Sonnet checking the medium issues. Faster; it may miss more." },
  cheap: { name: "Cheap", when: "Lighter models find, merge and plan; Opus still checks the critical and high issues." },
});
const DEPTH_NAMES = Object.keys(DEPTHS) as Depth[];
/** The words before a model on a card's row ("medium Sonnet 5.5 · high"), set apart from the model. */
const ROLE_PREFIX = /^(critical and high|medium|second opinion|its points checked by) (.+)$/u;

/** How many lines the run reads, once the project is read; null before. */
export interface ThoroughProps { readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly lines: number | null; readonly antigravity: "ready" | "missing" | "unknown"; readonly children?: ReactNode }

/**
 * How thorough, as one choice: a card per depth, each with what does each step and what a run of it will use. Two or
 * three finders is a choice of its own below the cards. A lineup the depths are not written for gets one card of its
 * own, read from its configuration.
 */
export function HowThorough({ draft, setDraft, lines, antigravity, children }: ThoroughProps): ReactElement {
  const subscription = isSubscriptionAudit(draft);
  const depth = String(draft["auditDepth"] ?? "deep");
  const finders = findersOf(draft);
  const input = { finders, reviewRound: Number(draft["maxConsensusRounds"] ?? 0) > 0, critic: getIn(draft, ["workflow", "critic"]) === true, lines };
  return <div className="thorough">
    {subscription ? <div aria-label="how thorough" className="lineup-cards" role="radiogroup">
      {DEPTH_NAMES.map((name) => {
        const chosen = name === depth;
        const shown = chosen ? draft : withDepth(draft, name);
        // A chosen depth whose models or efforts were changed by hand says so; choosing it again writes it afresh.
        const changed = chosen && stableJson(withDepth(draft, name)) !== stableJson(draft);
        return <LineupCard key={name} name={CARDS[name].name} when={CARDS[name].when} draft={shown} chosen={chosen} changed={changed} estimate={usageWords(usage({ ...input, depth: name }))}
          onChoose={() => setDraft(withDepth(draft, name))} />;
      })}
    </div> : <div className="lineup-cards"><LineupCard name="This lineup" when="Its models are its own: the depths are written for Claude Code and Codex." draft={draft} chosen changed={false} estimate={usageWords(usage({ ...input, depth: "unmeasured" }))} /></div>}
    {subscription && !DEPTH_NAMES.includes(depth as Depth) ? <p className="note">This lineup was saved at the earlier depth “{depth}”; choose a card to set its models and efforts.</p> : null}
    {subscription ? <ThirdFinder draft={draft} setDraft={setDraft} antigravity={antigravity} /> : null}
    {children}
  </div>;
}

function LineupCard({ name, when, draft, chosen, changed, estimate, onChoose }: { readonly name: string; readonly when: string; readonly draft: Draft; readonly chosen: boolean; readonly changed: boolean; readonly estimate: ReturnType<typeof usageWords>; readonly onChoose?: () => void }): ReactElement {
  const body = <>
    <span className="lineup-card__head">
      {onChoose === undefined ? null : <input aria-label={name} checked={chosen} name="depth" type="radio" value={name} onChange={onChoose} />}
      <span className="lineup-card__name">{name}</span>
      {estimate.basis === null ? null : <span className="lineup-card__tag">measured</span>}
    </span>
    <span className="lineup-card__when">{when}</span>
    <span className="lineup-card__rows">{lineupRows(draft).map(({ step, models }) => <span className="lineup-card__row" key={step}><span className="lineup-card__step">{step}</span><span>{models.map((model) => { const [, role, name] = ROLE_PREFIX.exec(model) ?? [model, null, model]; return <span className="lineup-card__model" key={model}>{typeof role === "string" ? <span className="lineup-card__role">{role} </span> : null}{name}</span>; })}</span></span>)}</span>
    {changed ? <span className="note">Changed by hand from the {name.toLowerCase()} lineup.</span> : null}
    <span className="lineup-card__usage">
      <span className="lineup-card__tokens">{estimate.tokens}</span>
      {estimate.vendors === null ? null : <span>{estimate.vendors}</span>}
      <span>{estimate.time}</span>
      {estimate.basis === null ? null : <span className="lineup-card__basis">{estimate.basis}</span>}
    </span>
  </>;
  return onChoose === undefined ? <div className="lineup-card" data-chosen="true">{body}</div> : <label className="lineup-card" data-chosen={chosen}>{body}</label>;
}

function ThirdFinder({ draft, setDraft, antigravity }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly antigravity: "ready" | "missing" | "unknown" }): ReactElement {
  const three = findersOf(draft) === 3;
  return <div className="switch-row">
    <label className="tick"><input aria-label="add a third finder" checked={three} type="checkbox" onChange={(event) => setDraft(withFinders(draft, event.target.checked ? 3 : 2))} />
      <span>Add a third finder: <span className="mono">Gemini 3.8 Flash · high</span>, through Antigravity</span></label>
    <p className="field__hint">It only finds issues, and they are checked like the others. On four runs it found 0 to 3 issues no other model found, for 1 to 2M tokens.{antigravity === "missing" ? " Antigravity is not on this computer." : ""}</p>
    <p className="field__hint">Google&apos;s terms say using the Antigravity CLI inside another app is not supported on its personal plans and may get the account suspended. Add it only if you accept that for your Google account.</p>
  </div>;
}

/** Every step of the lineup, with a switch where it can be off, a line on what it does, and who does it. */
export function StepsList({ draft, setDraft }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void }): ReactElement | null {
  const steps = stepsOf(draft);
  if (steps.length === 0) return null;
  return <ul aria-label="steps" className="steps">{steps.map((state) => <StepRow key={state.step.id} state={state} draft={draft} setDraft={setDraft} />)}</ul>;
}

function StepRow({ state, draft, setDraft }: { readonly state: StepState; readonly draft: Draft; readonly setDraft: (next: Draft) => void }): ReactElement {
  const { step, on, models } = state;
  const toggle = step.toggle;
  return <li className="step" data-on={on !== false}>
    <span className="step__name">{toggle === undefined ? <>{step.name}<span className="step__always">always</span></>
      : <label className="tick"><input aria-label={step.name} checked={on === true} type="checkbox" onChange={(event) => setDraft(toggle.set(draft, event.target.checked))} />{step.name}</label>}
      {toggle?.recommendOff === undefined ? null : <span className="step__always">recommended off</span>}</span>
    <span className="step__explain">{step.explain}{toggle?.recommendOff === undefined ? "" : ` ${toggle.recommendOff}`}</span>
    <span className="step__models">{models.join(" · ")}</span>
  </li>;
}

const PLAN_SCOPE = ["workflow", "modelExecution", "planScope", "minimumSeverity"] as const;

/** What goes into the plan: critical and high issues only, or medium ones too (the templates' default). */
export function PlanScope({ draft, setDraft }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void }): ReactElement | null {
  if (getIn(draft, ["workflow", "modelExecution"]) === undefined || draft["mode"] !== "audit") return null;
  const value = getIn(draft, PLAN_SCOPE);
  const skipped = getIn(draft, ["verification", "belowPlanScope"]) === "skip";
  const choose = (severity: string) => setDraft(setIn(draft, PLAN_SCOPE, severity));
  const own = value !== "high" && value !== "medium";
  return <div aria-label="what goes into the plan" className="plan-scope" role="radiogroup">
    <label className="choice"><input aria-label="Critical and high issues only" checked={value === "high"} name="plan-scope" type="radio" onChange={() => choose("high")} />
      <span><span className="choice__name">Critical and high issues only</span>
        <span className="field__hint">Medium issues are listed in the plan without tasks{skipped ? ", and not checked" : ""}. On the measured runs medium issues were 77 to 91% of what was checked, and checking about 55% of a run&apos;s tokens.</span></span></label>
    <label className="choice"><input aria-label="Medium issues too" checked={value === "medium"} name="plan-scope" type="radio" onChange={() => choose("medium")} />
      <span><span className="choice__name">Medium issues too</span>
        <span className="field__hint">Every critical, high and medium issue is checked, and each confirmed one gets a task. The measured runs planned this way.</span></span></label>
    {own ? <p className="note">This lineup sets its own: {typeof value === "string" ? `${value} and up` : "every confirmed issue, low ones too"}.</p> : null}
  </div>;
}
