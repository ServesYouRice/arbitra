import { useState, type ReactElement, type ReactNode } from "react";
import { stableJson } from "../../graph/editor-model.js";
import { effortFor } from "../run/models.js";
import { aliasOf, COMPATIBLE_PRESETS, customProblem, effortChoices, effortLevel, optionName, optionValue, ROLE_STAGE, seatOptions, seatValue, withCustomModel, withSeatEffort, withSeatOption, withThirdFinder, type CustomModel, type Seat } from "./assign.js";
import { DEPTHS, findersOf, isDepthLineup, withDepth, type Depth } from "./depth.js";
import { getIn, setIn, type Draft } from "./draft.js";
import { lineupRows, stepsOf, type StepSeat, type StepState } from "./lineup.js";
import type { OfferedModels } from "./model-catalog.js";
import { routeOf, withRoute, type Route } from "./routes.js";
import { usage, usageWords } from "./usage.js";

/** Each depth in a few words: what it is, and when to choose it. The models and efforts are read from the draft. */
const CARDS: Readonly<Record<Depth, { readonly name: string; readonly when: string }>> = Object.freeze({
  deep: { name: "Deep", when: "The strongest models at full effort: the lineup the measured runs used." },
  balanced: { name: "Balanced", when: "The same models at medium effort; Sonnet checks the medium issues. Faster, may miss more." },
  cheap: { name: "Cheap", when: "Lighter models find, merge and plan; Opus still checks the critical and high issues." },
});
const DEPTH_NAMES = Object.keys(DEPTHS) as Depth[];
/** What reaches a finder, as its share of a run's tokens is named. */
const SPLIT_NAMES: Readonly<Record<string, string>> = Object.freeze({ "claude-code-cli": "Claude Code", "codex-cli": "Codex", "antigravity-cli": "Antigravity",
  "anthropic-messages": "Anthropic's API", "openai-responses": "OpenAI's API", "gemini-native": "Gemini's API", "openai-chat": "the third finder" });
/** The words before a model on a card's row ("medium Sonnet 5.5 · high"), set apart from the model. */
const ROLE_PREFIX = /^(critical and high|medium|second opinion|its points checked by) (.+)$/u;

export interface ThoroughProps {
  readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly lines: number | null; readonly offered: OfferedModels;
  readonly antigravity: "ready" | "missing" | "unknown"; readonly children?: ReactNode;
}

/**
 * How thorough: a card per depth, each a preset of every step's model and effort with what a run of it will use. A
 * card fills the lineup; the steps below change any step in place, which marks the lineup changed, and choosing the
 * card again writes the preset afresh. How the models are reached (the CLIs here, or API keys) is a choice of its own,
 * and so is a third finder. A lineup the depths are not written for gets one card of its own, read from it.
 */
export function HowThorough({ draft, setDraft, lines, offered, antigravity, children }: ThoroughProps): ReactElement {
  const depths = isDepthLineup(draft);
  const route = routeOf(draft);
  const depth = String(draft["auditDepth"] ?? "deep");
  const input = { finders: findersOf(draft), reviewRound: Number(draft["maxConsensusRounds"] ?? 0) > 0, critic: getIn(draft, ["workflow", "critic"]) === true, lines,
    names: ["auditor-a", "auditor-b", "auditor-c"].map((alias, index) => SPLIT_NAMES[String(getIn(draft, ["models", alias, "transport"]) ?? "")] ?? ["Claude", "GPT", "the third finder"][index] ?? alias) };
  const measured = usageWords(usage({ ...input, depth: "deep" }));
  return <div className="thorough">
    {depths && route !== null ? <RouteChoice draft={draft} route={route} setDraft={setDraft} /> : null}
    {depths ? <div aria-label="how thorough" className="lineup-cards" role="radiogroup">
      {DEPTH_NAMES.map((name) => {
        const chosen = name === depth;
        const changed = chosen && stableJson(withDepth(draft, name)) !== stableJson(draft);
        return <LineupCard key={name} name={CARDS[name].name} when={CARDS[name].when} draft={chosen ? draft : withDepth(draft, name)} chosen={chosen} changed={changed}
          estimate={usageWords(usage({ ...input, depth: name }))} viaApi={route === "api"} onChoose={() => setDraft(withDepth(draft, name))} />;
      })}
    </div> : <div className="lineup-cards"><LineupCard name="This lineup" when="Its models are its own: the depths are written for a Claude and a GPT finder." draft={draft} chosen changed={false}
      estimate={usageWords(usage({ ...input, depth: "unmeasured" }))} viaApi={false} /></div>}
    {depths && !DEPTH_NAMES.includes(depth as Depth) ? <p className="note">This lineup was saved at the earlier depth “{depth}”; choose a card to set its models and efforts.</p> : null}
    {measured.basis === null ? null : <details className="fold"><summary>How the estimates are made</summary><p className="note">{measured.basis} Tokens are split as rokbot (two finders) and nextra (three, Gemini 3.8 Flash the third) split; another third finder is given Gemini's share, not measured. A time is given only for a project within a tenth of the sizes measured. Balanced and cheap have not run on a real project yet.</p></details>}
    {depths ? <ThirdFinder draft={draft} setDraft={setDraft} offered={offered} antigravity={antigravity} /> : null}
    {children}
  </div>;
}

function RouteChoice({ draft, route, setDraft }: { readonly draft: Draft; readonly route: Route; readonly setDraft: (next: Draft) => void }): ReactElement {
  const keys = ((getIn(draft, ["workflow", "modelExecution", "endpoints"]) ?? []) as readonly { readonly apiKeyEnvVar?: string }[]).flatMap(({ apiKeyEnvVar }) => apiKeyEnvVar === undefined ? [] : [apiKeyEnvVar]);
  return <div aria-label="models run through" className="route" role="radiogroup">
    <span className="route__label">Models run through</span>
    <label className="choice-inline"><input aria-label="the CLIs on this computer" checked={route === "cli"} name="route" type="radio" onChange={() => setDraft(withRoute(draft, "cli"))} />the CLIs on this computer</label>
    <label className="choice-inline"><input aria-label="API keys" checked={route === "api"} name="route" type="radio" onChange={() => setDraft(withRoute(draft, "api"))} />API keys</label>
    <span className="field__hint">{route === "cli" ? "Claude Code and Codex, signed in with your subscriptions; no API key is used." : `Each vendor's API, billed by the vendor, with the key arbitra finds in ${keys.join(", ")}.`}</span>
  </div>;
}

function LineupCard({ name, when, draft, chosen, changed, estimate, viaApi, onChoose }: {
  readonly name: string; readonly when: string; readonly draft: Draft; readonly chosen: boolean; readonly changed: boolean;
  readonly estimate: ReturnType<typeof usageWords>; readonly viaApi: boolean; readonly onChoose?: () => void;
}): ReactElement {
  return <div className="lineup-card" data-chosen={chosen} onClick={onChoose}>
    <span className="lineup-card__head">
      {onChoose === undefined ? null : <input aria-label={name} checked={chosen} name="depth" type="radio" value={name} onChange={onChoose} />}
      <span className="lineup-card__name">{changed ? `${name}, changed` : name}</span>
      {estimate.basis === null ? null : <span className="lineup-card__tag">measured</span>}
    </span>
    <span className="lineup-card__when">{when}</span>
    <span className="lineup-card__rows">{lineupRows(draft).map(({ step, models }) => <span className="lineup-card__row" key={step}><span className="lineup-card__step">{step}</span><span>{models.map((model) => {
      const [, role, modelName] = ROLE_PREFIX.exec(model) ?? [model, null, model];
      return <span className="lineup-card__model" key={model}>{typeof role === "string" ? <span className="lineup-card__role">{role} </span> : null}{modelName}</span>;
    })}</span></span>)}</span>
    {changed ? <button className="link-button" type="button" onClick={(event) => { event.stopPropagation(); onChoose?.(); }}>reset to {name.toLowerCase()}</button> : null}
    <span className="lineup-card__usage">
      <span className="lineup-card__tokens">{estimate.tokens}</span>
      {estimate.vendors === null ? null : <span>{estimate.vendors}</span>}
      <span>{estimate.time}</span>
      {estimate.short === null ? null : <span className="lineup-card__basis">{estimate.short}{viaApi ? ", through the CLIs" : ""}</span>}
    </span>
  </div>;
}

/** The third finder: off, or on with a model chosen from what the lineup reaches, Gemini first. */
function ThirdFinder({ draft, setDraft, offered, antigravity }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly offered: OfferedModels; readonly antigravity: "ready" | "missing" | "unknown" }): ReactElement {
  const on = findersOf(draft) === 3 && aliasOf(draft, { kind: "finder", alias: "auditor-c" }) !== undefined;
  const transport = String(getIn(draft, ["models", "auditor-c", "transport"]) ?? "");
  const flash = /^gemini-3\.8-flash/u.test(String(getIn(draft, ["models", "auditor-c", "modelId"]) ?? ""));
  return <div className="third-finder">
    <div className="third-finder__row">
      <label className="tick"><input aria-label="add a third finder" checked={on} type="checkbox" onChange={(event) => setDraft(withThirdFinder(draft, event.target.checked ? "default" : null, offered))} /><span>Add a third finder</span></label>
      {on ? <SeatPicker draft={draft} setDraft={setDraft} seat={{ kind: "finder", alias: "auditor-c" }} offered={offered} words="third finder" /> : <span className="note">Gemini 3.8 Flash · high unless you choose another</span>}
    </div>
    <p className="field__hint">It only finds issues, and they are checked like the others. It adds the most from a vendor the other two finders do not use. On four runs Gemini 3.8 Flash found 0 to 3 issues no other model found, for 1 to 2M tokens{flash || !on ? "" : "; this model as a third finder is not measured"}.{on && transport === "antigravity-cli" && antigravity === "missing" ? " Antigravity is not on this computer." : ""}</p>
    {on && transport === "antigravity-cli" ? <p className="field__hint">Through Antigravity: Google&apos;s terms say using its CLI inside another app is not supported on personal plans and may get the account suspended.</p> : null}
  </div>;
}

/** The words a seat's controls are named by: "model: write the plan", "effort: finder 1". */
const ROLE_WORDS: Readonly<Record<string, string>> = Object.freeze({ merger: "merge duplicates", verifier: "check each issue", mediumVerifier: "check medium issues", secondOpinion: "second opinion",
  variantSearcher: "search for variants", planner: "write the plan", critic: "review the plan", critiqueChecker: "check the plan review" });
const FINDER_WORDS: Readonly<Record<string, string>> = Object.freeze({ "auditor-a": "finder 1", "auditor-b": "finder 2", "auditor-c": "third finder" });
const seatWords = (seat: Seat, label?: string): string => seat.kind === "finder" ? FINDER_WORDS[seat.alias] ?? seat.alias : seat.kind === "stage" ? "review round"
  : label === "critical and high" ? "check critical and high issues" : ROLE_WORDS[seat.role] ?? seat.role;

/**
 * A seat's model and effort, chosen in place: the model from what the lineup reaches (grouped by the CLI or API that
 * reaches it), the effort in that model's own words. A seat whose models are the finders (the review round) has an
 * effort only.
 */
function SeatPicker({ draft, setDraft, seat, offered, words }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly seat: Seat; readonly offered: OfferedModels; readonly words: string }): ReactElement {
  const [adding, setAdding] = useState(false);
  if (seat.kind === "stage") {
    const levels = effortChoices(draft, "auditor-a", offered);
    const current = effortLevel(draft, seat.stage, "auditor-a") ?? effortFor(draft, "auditor-a", seat.stage);
    return <span className="seat"><EffortSelect words={words} levels={levels} current={current} onChange={(level) => setDraft(withSeatEffort(draft, seat, level, offered))} /></span>;
  }
  const alias = aliasOf(draft, seat);
  if (alias === undefined) return <span className="seat note">chosen when switched on</span>;
  const transport = String(getIn(draft, ["models", alias, "transport"]) ?? "");
  const modelId = String(getIn(draft, ["models", alias, "modelId"]) ?? "");
  const groups = seatOptions(draft, seat, offered);
  const value = seatValue(draft, alias);
  const listed = groups.some((group) => group.models.some((model) => optionValue(group, model.modelId) === value));
  const stage = seat.kind === "finder" ? "discovery" : ROLE_STAGE[seat.role];
  const levels = effortChoices(draft, alias, offered);
  const inId = /-(low|medium|high)$/u.exec(modelId)?.[1];
  const current = inId !== undefined && transport === "antigravity-cli" ? inId : effortLevel(draft, stage, alias) ?? effortFor(draft, alias, stage);
  // The first two finders stay a Claude and a GPT model, so the depths apply; any other seat takes a model the person names.
  const named = !(seat.kind === "finder" && (seat.alias === "auditor-a" || seat.alias === "auditor-b"));
  return <span className="seat">
    <select aria-label={`model: ${words}`} value={value} onChange={(event) => { if (event.target.value === ADD) setAdding(true); else setDraft(withSeatOption(draft, seat, event.target.value, offered)); }}>
      {listed ? null : <option value={value}>{modelId} (this lineup&apos;s)</option>}
      {groups.map((group) => <optgroup key={group.key} label={group.label}>
        {group.models.map((model) => <option key={model.modelId} value={optionValue(group, model.modelId)}>{optionName(group.transport, model)}</option>)}
      </optgroup>)}
      {named ? <option value={ADD}>another model: an OpenAI-compatible endpoint…</option> : null}
    </select>
    {levels.length === 0 ? <span className="note">its own effort</span> : <EffortSelect words={words} levels={levels} current={current} onChange={(level) => setDraft(withSeatEffort(draft, seat, level, offered))} />}
    {adding ? <AddModel words={words} onCancel={() => setAdding(false)} onUse={(custom) => { setAdding(false); setDraft(withCustomModel(draft, seat, custom, offered)); }} /> : null}
  </span>;
}

const ADD = "add another model";

/**
 * A model the person names: an OpenAI-compatible endpoint by its base URL, the model's ID there, and the environment
 * variable holding its key. The endpoints people use most are offered to fill the address in; they are a convenience,
 * not the limit. arbitra has no measurements for such a model.
 */
function AddModel({ words, onUse, onCancel }: { readonly words: string; readonly onUse: (custom: CustomModel) => void; readonly onCancel: () => void }): ReactElement {
  const first = COMPATIBLE_PRESETS[0];
  const [custom, setCustom] = useState<CustomModel>({ preset: first?.id ?? "compatible", baseUrl: first?.baseUrl ?? "", modelId: "", keyVar: first?.keyVar ?? "" });
  const preset = COMPATIBLE_PRESETS.find(({ id }) => id === custom.preset);
  const problem = customProblem(custom);
  return <span aria-label={`another model: ${words}`} className="add-model" role="group">
    <label className="field">where
      <select aria-label={`endpoint: ${words}`} value={custom.preset} onChange={(event) => { const chosen = COMPATIBLE_PRESETS.find(({ id }) => id === event.target.value); if (chosen !== undefined) setCustom({ ...custom, preset: chosen.id, baseUrl: chosen.baseUrl, keyVar: chosen.keyVar }); }}>
        {COMPATIBLE_PRESETS.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>
    <label className="field">base URL<input aria-label={`base URL: ${words}`} spellCheck={false} value={custom.baseUrl} onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })} /></label>
    <label className="field">model ID<input aria-label={`model ID: ${words}`} placeholder={preset?.example ?? ""} spellCheck={false} value={custom.modelId} onChange={(event) => setCustom({ ...custom, modelId: event.target.value })} /></label>
    <label className="field">key variable<input aria-label={`key variable: ${words}`} spellCheck={false} value={custom.keyVar} onChange={(event) => setCustom({ ...custom, keyVar: event.target.value })} /></label>
    <span className="add-model__actions">
      <button className="button button--small" disabled={problem !== null} type="button" onClick={() => onUse(custom)}>use it</button>
      <button className="link-button" type="button" onClick={onCancel}>cancel</button>
      <span className="field__hint">{problem ?? "Not measured: arbitra has run no audit with it. The key stays in the environment arbitra runs in; only the variable's name is saved."}</span>
    </span>
  </span>;
}

function EffortSelect({ words, levels, current, onChange }: { readonly words: string; readonly levels: readonly string[]; readonly current: string; readonly onChange: (level: string) => void }): ReactElement {
  return <select aria-label={`effort: ${words}`} className="seat__effort" value={current} onChange={(event) => onChange(event.target.value)}>
    {levels.includes(current) ? null : <option value={current}>{current}</option>}
    {levels.map((level) => <option key={level} value={level}>{level}</option>)}
  </select>;
}

/**
 * Every step of the lineup on one row: its switch where it can be off, its name, and who does it, changed in place.
 * What it does is one muted line; the measured reason a step is recommended off is one click down.
 */
export function StepsList({ draft, setDraft, offered }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly offered: OfferedModels }): ReactElement | null {
  const steps = stepsOf(draft);
  if (steps.length === 0) return null;
  return <ul aria-label="steps" className="steps">{steps.map((state) => <StepRow key={state.step.id} state={state} draft={draft} setDraft={setDraft} offered={offered} />)}</ul>;
}

function StepRow({ state, draft, setDraft, offered }: { readonly state: StepState; readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly offered: OfferedModels }): ReactElement {
  const { step, on, models } = state;
  const toggle = step.toggle;
  const seats: readonly StepSeat[] = on === false ? [] : step.seats(draft);
  return <li className="step" data-on={on !== false}>
    <span className="step__name">{toggle === undefined ? <>{step.name}<span className="step__always">always</span></>
      : <label className="tick"><input aria-label={step.name} checked={on === true} type="checkbox" onChange={(event) => setDraft(toggle.set(draft, event.target.checked))} />{step.name}</label>}
      {toggle?.recommendOff === undefined ? null : <span className="step__always">recommended off</span>}</span>
    <span className="step__seats">{on === false ? <span className="step__models">{models.join(" · ")}</span>
      : seats.map(({ seat, label }) => <span className="step__seat" key={`${seat.kind}-${seat.kind === "finder" ? seat.alias : seat.kind === "role" ? seat.role : seat.stage}`}>
        {label === undefined ? null : <span className="step__label">{label}</span>}
        <SeatPicker draft={draft} setDraft={setDraft} seat={seat} offered={offered} words={seatWords(seat, label)} />
      </span>)}{step.id === "find" && on !== false && getIn(draft, ["models", "auditor-c"]) !== undefined ? <span className="step__label">and the third finder, chosen above</span> : null}</span>
    <span className="step__explain">{step.explain}{toggle?.recommendOff === undefined && step.more === undefined ? null
      : <details className="step__more"><summary>{toggle?.recommendOff === undefined ? "more" : "why it is off"}</summary>{toggle?.recommendOff ?? ""}{toggle?.recommendOff !== undefined && step.more !== undefined ? " " : ""}{step.more ?? ""}</details>}</span>
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
        <span className="field__hint">Medium issues are listed without tasks{skipped ? " and not checked" : ""}. On the measured runs they were 77 to 91% of what was checked, and checking about 55% of a run&apos;s tokens.</span></span></label>
    <label className="choice"><input aria-label="Medium issues too" checked={value === "medium"} name="plan-scope" type="radio" onChange={() => choose("medium")} />
      <span><span className="choice__name">Medium issues too</span>
        <span className="field__hint">Every critical, high and medium issue is checked and gets a task. The measured runs planned this way.</span></span></label>
    {own ? <p className="note">This lineup sets its own: {typeof value === "string" ? `${value} and up` : "every confirmed issue, low ones too"}.</p> : null}
  </div>;
}
