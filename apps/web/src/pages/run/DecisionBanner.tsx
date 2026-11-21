import { NODE_GLYPHS } from "@arbitra/schemas/glyphs";
import { useState, type ReactElement } from "react";
import type { HumanCheckpointResource, PlanQuestion, PlanQuestionAnswer, PlanQuestionsCheckpointResource, RequirementsCheckpointResource, RunOverview, RunResource } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { Link } from "../../app/router.js";
import { resumeRefusalWords, type Mode } from "../../app/words.js";
import { Problem } from "./RunHeader.js";
import { RepositoryChanged, reusesFinishedWork } from "./RepositoryChanged.js";

/**
 * A blocked run does nothing until the operator acts, so its decisions sit above every tab.
 * A decision is recorded immediately; the run continues only on an explicit resume, which
 * is offered once nothing is left to decide. A refused decision or resume says in words what to do, and the code the
 * server recorded sits one click down, as the header's refused resume does.
 */
export function DecisionBanner({ runId, run, mode, overview, onChanged }: { readonly runId: string; readonly run: RunResource | null; readonly mode: Mode; readonly overview: RunOverview | null; readonly onChanged: () => void }): ReactElement | null {
  const { runs } = useApis();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly detail: string; readonly resume: boolean } | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  if (run === null || run.state !== "BLOCKED") return null;
  const human = run.checkpoints.filter((checkpoint): checkpoint is HumanCheckpointResource => checkpoint.kind === "human");
  const pending = human.filter(({ status }) => status === "pending");
  const requirements = run.checkpoints.find((checkpoint): checkpoint is RequirementsCheckpointResource => checkpoint.kind === "requirements");
  const approvals = requirements?.pendingAmbiguityIds ?? [];
  const questions = run.checkpoints.find((checkpoint): checkpoint is PlanQuestionsCheckpointResource => checkpoint.kind === "plan-questions");
  const unanswered = questions?.status === "pending" ? questions : undefined;
  const open = pending.length + approvals.length + (unanswered === undefined ? 0 : 1);
  const words = failure?.resume === true ? resumeRefusalWords(failure.detail, mode) : null;
  const act = async (label: string, operation: () => Promise<unknown>, resume = false): Promise<void> => {
    setBusy(true); setFailure(null); setRecorded(null);
    try { await operation(); setRecorded(label); onChanged(); }
    catch (cause) { setFailure({ detail: cause instanceof Error ? cause.message : String(cause), resume }); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="decision-title" className="decision">
    <h2 className="decision__title" id="decision-title"><span aria-hidden="true">{NODE_GLYPHS.human.glyph}</span> This run is waiting for your decision</h2>
    {pending.map((checkpoint) => <div className="decision__item checkpoint" key={checkpoint.checkpointId}>
      <p className="panel-title">checkpoint · {checkpoint.checkpointId}</p>
      <p className="prose">{checkpoint.prompt}</p>
      <div className="actions">
        {checkpoint.decisions.includes("approve") ? <button className="button button--primary" disabled={busy} type="button" onClick={() => { void act(`approved ${checkpoint.checkpointId}`, () => runs.respondCheckpoint(runId, checkpoint.checkpointId, checkpoint.version, "approve")); }}>approve</button> : null}
        {checkpoint.decisions.includes("reject") ? <button className="button" disabled={busy} type="button" onClick={() => { void act(`rejected ${checkpoint.checkpointId}`, () => runs.respondCheckpoint(runId, checkpoint.checkpointId, checkpoint.version, "reject")); }}>reject</button> : null}
      </div>
    </div>)}
    {unanswered === undefined ? null : <PlanQuestionsForm busy={busy} checkpoint={unanswered} key={unanswered.version} onSubmit={(answers, acceptSuggested) => { void act("answers recorded", () => runs.answerPlanQuestions(runId, unanswered.version, answers, acceptSuggested)); }} />}
    {requirements === undefined ? null : <div className="decision__item">
      <p className="prose">{approvals.length === 0 ? "No proposed default is waiting for approval." : `${approvals.length === 1 ? "1 proposed default needs" : `${approvals.length} proposed defaults need`} your approval: ${approvals.join(", ")}.`}{requirements.revisionProposalArtifactId === undefined ? "" : " A model revision proposal is waiting to be applied or set aside."}</p>
      <p><Link to={{ page: "run", runId, tab: "requirements", item: null }}>review the requirements</Link></p>
    </div>}
    {human.filter(({ status }) => status !== "pending").map((checkpoint) => <p className="state" data-state={checkpoint.status === "approved" ? "verified" : "refuted"} key={checkpoint.checkpointId}>checkpoint {checkpoint.checkpointId} · {checkpoint.status}</p>)}
    {questions?.status === "answered" ? <p className="state" data-state="verified">plan questions · answered</p> : null}
    <div className="actions">
      <button className="button button--primary" disabled={busy || open > 0} type="button" onClick={() => { void act("resume requested", () => runs.resume(runId), true); }}>resume run</button>
      <p className="note">{open > 0 ? "Answer or decide each item above first. Each is recorded at once; the run continues only when you resume it." : "Your decisions are recorded. The run stays blocked until you resume it."}</p>
    </div>
    {recorded === null ? null : <p className="state" data-state="verified" role="status">{recorded}</p>}
    {failure === null ? null : failure.resume && /RUN_REPOSITORY_CHANGED/u.test(failure.detail) ? <RepositoryChanged runId={runId} mode={mode} detail={failure.detail} reuse={reusesFinishedWork(mode, overview)} />
      : <Problem detail={failure.detail}>{words === null ? "That did not go through, and the run is as it was. Try again, or reload the page to see where it stands." : `${words.what} ${words.todo}`}</Problem>}
  </section>;
}

/** Why no model of another vendor answered the plan's questions, in words, when it was not asked. */
function uncheckedWords(check: PlanQuestionsCheckpointResource["check"]): string | null {
  if (check === undefined || check.status === "answered" || check.status === "nothing_to_check") return null;
  if (check.status === "off") return "The run switched off the second model's answers, so answer each question one by one.";
  if (check.status === "no_other_vendor") return "No model of another vendor than the planner's is in this run to answer them too, so answer each question one by one.";
  return `The second model${check.profile === undefined ? "" : ` (${check.profile})`} could not answer them this time${check.reason === undefined ? "" : `: ${check.reason}`}. Answer each question one by one.`;
}

/** One question's answer as the form holds it: one of its choices by index, or written ("other"). */
interface Draft { readonly choice: number | "other" | null; readonly text: string }

/**
 * An interactive Audit's plan left blocking questions open. Every one needs an answer, and
 * the answers are sent once, for this exact version of the plan; on resume the planner
 * revises the plan with them. The planner suggests an answer to each, listed first; a model of
 * another vendor answers them on its own, and its answer is listed next when it differs. Where
 * both proposed the same answer and neither rates a wrong one's impact high, the suggestions can
 * be accepted together; every other question is answered one by one, since a suggestion is easy
 * to follow when it is wrong. None is chosen in advance.
 */
function PlanQuestionsForm({ checkpoint, busy, onSubmit }: { readonly checkpoint: PlanQuestionsCheckpointResource; readonly busy: boolean; readonly onSubmit: (answers: readonly PlanQuestionAnswer[], acceptSuggested: boolean) => void }): ReactElement {
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [together, setTogether] = useState(false);
  const acceptable = checkpoint.questions.filter(({ acceptable: ok }) => ok === true);
  const oneByOne = together ? checkpoint.questions.filter(({ acceptable: ok }) => ok !== true) : checkpoint.questions;
  const draftOf = (id: string): Draft => drafts[id] ?? { choice: null, text: "" };
  const answerOf = ({ id, choices }: PlanQuestion): PlanQuestionAnswer | null => {
    const { choice, text } = draftOf(id);
    if (choices === undefined || choice === "other") return text.trim() === "" ? null : { questionId: id, answer: text.trim() };
    return choice === null ? null : { questionId: id, choice };
  };
  const answers = oneByOne.map(answerOf);
  const complete = answers.every((answer) => answer !== null);
  const set = (id: string, next: Partial<Draft>) => { setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? { choice: null, text: "" }), ...next } })); };
  const count = checkpoint.questions.length;
  const unchecked = uncheckedWords(checkpoint.check);
  return <form aria-label="plan questions" className="decision__item" onSubmit={(event) => { event.preventDefault(); if (complete) onSubmit(answers.filter((answer): answer is PlanQuestionAnswer => answer !== null), together && acceptable.length > 0); }}>
    <p className="panel-title">plan questions · {count} blocking</p>
    <p className="prose">The plan leaves {count === 1 ? "a question" : `${count} questions`} open that {count === 1 ? "stops" : "stop"} it passing its gate. Answer each one; when you resume, the planner revises the plan with your answers. They are sent once, for this version of the plan.</p>
    {unchecked === null ? null : <p className="note">{unchecked}</p>}
    {acceptable.length === 0 ? null : <div className="plan-answers__together">
      <label className="plan-answer"><input checked={together} type="checkbox" onChange={(event) => { setTogether(event.target.checked); }} />
        <span>Accept all suggested: the {acceptable.length === 1 ? "question" : `${acceptable.length} questions`} both models answered alike</span></label>
      <p className="note">Both proposed the same answer and neither rates a wrong one's impact high. {together ? "Taken as suggested:" : "They are:"} {acceptable.map(({ id, suggestion }) => `${id} (${suggestion?.answer ?? ""})`).join("; ")}.{acceptable.length === count ? "" : " Answer the others one by one."}</p>
    </div>}
    {oneByOne.map((entry) => <PlanQuestionField draft={draftOf(entry.id)} entry={entry} key={entry.id} onChange={(next) => { set(entry.id, next); }} />)}
    <div className="actions"><button className="button button--primary" disabled={busy || !complete} type="submit">send answers</button></div>
  </form>;
}

/** One question answered on its own: the suggestion, the other model's answer when it differs, the others weighed, or one written out. */
function PlanQuestionField({ entry, draft, onChange }: { readonly entry: PlanQuestion; readonly draft: Draft; readonly onChange: (next: Partial<Draft>) => void }): ReactElement {
  const { id, question, blastRadius, choices, suggestion, check } = entry;
  if (choices === undefined) return <label className="field">
    <span>{id} · {blastRadius} impact</span>
    <span className="prose">{question}</span>
    <textarea rows={3} value={draft.text} onChange={(event) => { onChange({ text: event.target.value }); }} />
  </label>;
  // The suggestion first, the other model's own answer next when it differs, then the rest the planner weighed.
  const order = [0, ...(check === undefined || check.agrees ? [] : [check.choice]), ...choices.map((_, index) => index).filter((index) => index !== 0 && index !== check?.choice)];
  const name = `plan-answer-${id}`;
  return <fieldset className="field plan-answer__question">
    <legend>{id} · {blastRadius} impact{check?.agrees === true ? " · both models agree" : ""}</legend>
    <span className="prose">{question}</span>
    {order.map((index) => <label className="plan-answer" key={index}><input checked={draft.choice === index} name={name} type="radio" onChange={() => { onChange({ choice: index }); }} />
      <span>{choices[index]}
        {index === 0 ? <span className="field__hint">Suggested{check?.agrees === true ? " by both models" : ""}: {suggestion?.reason}{check?.agrees === true && check.blastRadius === "high" ? " The other model rates a wrong answer's impact high." : ""}</span> : null}
        {index !== 0 && index === check?.choice ? <span className="field__hint">Another model{check.profile === undefined ? "" : ` (${check.profile})`} answered this: {check.reason}{check.blastRadius === "high" ? " It rates a wrong answer's impact high." : ""}</span> : null}</span>
    </label>)}
    <label className="plan-answer"><input checked={draft.choice === "other"} name={name} type="radio" onChange={() => { onChange({ choice: "other" }); }} /><span>Other</span></label>
    {draft.choice === "other" ? <textarea aria-label={`${id} · your answer`} rows={3} value={draft.text} onChange={(event) => { onChange({ text: event.target.value }); }} /> : null}
  </fieldset>;
}
