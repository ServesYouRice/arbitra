import { NODE_GLYPHS } from "@arbitra/schemas/glyphs";
import { useState, type ReactElement } from "react";
import type { HumanCheckpointResource, PlanQuestionsCheckpointResource, RequirementsCheckpointResource, RunResource } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { Link } from "../../app/router.js";

/**
 * A blocked run does nothing until the operator acts, so its decisions sit above every tab.
 * A decision is recorded immediately; the run continues only on an explicit resume, which
 * is offered once nothing is left to decide.
 */
export function DecisionBanner({ runId, run, onChanged }: { readonly runId: string; readonly run: RunResource | null; readonly onChanged: () => void }): ReactElement | null {
  const { runs } = useApis();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  if (run === null || run.state !== "BLOCKED") return null;
  const human = run.checkpoints.filter((checkpoint): checkpoint is HumanCheckpointResource => checkpoint.kind === "human");
  const pending = human.filter(({ status }) => status === "pending");
  const requirements = run.checkpoints.find((checkpoint): checkpoint is RequirementsCheckpointResource => checkpoint.kind === "requirements");
  const approvals = requirements?.pendingAmbiguityIds ?? [];
  const questions = run.checkpoints.find((checkpoint): checkpoint is PlanQuestionsCheckpointResource => checkpoint.kind === "plan-questions");
  const unanswered = questions?.status === "pending" ? questions : undefined;
  const open = pending.length + approvals.length + (unanswered === undefined ? 0 : 1);
  const act = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setFailure(null); setRecorded(null);
    try { await operation(); setRecorded(label); onChanged(); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); }
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
    {unanswered === undefined ? null : <PlanQuestionsForm busy={busy} checkpoint={unanswered} key={unanswered.version} onSubmit={(answers) => { void act("answers recorded", () => runs.answerPlanQuestions(runId, unanswered.version, answers)); }} />}
    {requirements === undefined ? null : <div className="decision__item">
      <p className="prose">{approvals.length === 0 ? "No proposed default is waiting for approval." : `${approvals.length === 1 ? "1 proposed default needs" : `${approvals.length} proposed defaults need`} your approval: ${approvals.join(", ")}.`}{requirements.revisionProposalArtifactId === undefined ? "" : " A model revision proposal is waiting to be applied or set aside."}</p>
      <p><Link to={{ page: "run", runId, tab: "requirements", item: null }}>review the requirements</Link></p>
    </div>}
    {human.filter(({ status }) => status !== "pending").map((checkpoint) => <p className="state" data-state={checkpoint.status === "approved" ? "verified" : "refuted"} key={checkpoint.checkpointId}>checkpoint {checkpoint.checkpointId} · {checkpoint.status}</p>)}
    {questions?.status === "answered" ? <p className="state" data-state="verified">plan questions · answered</p> : null}
    <div className="actions">
      <button className="button button--primary" disabled={busy || open > 0} type="button" onClick={() => { void act("resume requested", () => runs.resume(runId)); }}>resume run</button>
      <p className="note">{open > 0 ? "Answer or decide each item above first. Each is recorded at once; the run continues only when you resume it." : "Your decisions are recorded. The run stays blocked until you resume it."}</p>
    </div>
    {recorded === null ? null : <p className="state" data-state="verified" role="status">{recorded}</p>}
    {failure === null ? null : <p className="state" data-state="degraded" role="alert">{failure}</p>}
  </section>;
}

/**
 * An interactive Audit's plan left blocking questions open. Every one needs an answer, and
 * the answers are sent once, for this exact version of the plan; on resume the planner
 * revises the plan with them.
 */
function PlanQuestionsForm({ checkpoint, busy, onSubmit }: { readonly checkpoint: PlanQuestionsCheckpointResource; readonly busy: boolean; readonly onSubmit: (answers: readonly { readonly questionId: string; readonly answer: string }[]) => void }): ReactElement {
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const complete = checkpoint.questions.every(({ id }) => (answers[id] ?? "").trim() !== "");
  const count = checkpoint.questions.length;
  return <form aria-label="plan questions" className="decision__item" onSubmit={(event) => { event.preventDefault(); if (complete) onSubmit(checkpoint.questions.map(({ id }) => ({ questionId: id, answer: (answers[id] ?? "").trim() }))); }}>
    <p className="panel-title">plan questions · {count} blocking</p>
    <p className="prose">The plan leaves {count === 1 ? "a question" : `${count} questions`} open that {count === 1 ? "stops" : "stop"} it passing its gate. Answer each one; when you resume, the planner revises the plan with your answers. They are sent once, for this version of the plan.</p>
    {checkpoint.questions.map(({ id, question, blastRadius }) => <label className="field" key={id}>
      <span>{id} · {blastRadius} impact</span>
      <span className="prose">{question}</span>
      <textarea rows={3} value={answers[id] ?? ""} onChange={(event) => { const value = event.target.value; setAnswers((current) => ({ ...current, [id]: value })); }} />
    </label>)}
    <div className="actions"><button className="button button--primary" disabled={busy || !complete} type="submit">send answers</button></div>
  </form>;
}
