import "./plan-tab.css";
import { useState, type ReactElement } from "react";
import type { ArtifactDescriptor } from "../../api/artifacts.js";
import { useLoaded, type PlanOutline, type RunOverview } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { Link } from "../../app/router.js";
import { counted, severityWord, tierWord } from "../../app/words.js";
import { RUN_ARTIFACT_KINDS, useRunArtifact } from "../../views/issue-board/run-artifacts.js";
import { PlanView } from "../../views/plan/PlanView.js";
import type { PersistedPlan, TraceLevel } from "../../views/plan/traceability.js";
import { criticWords, type CritiqueRecord } from "./facts.js";
import { modelsOfTier } from "./models.js";
import { PlanCard } from "./PlanCard.js";

/** How many tasks the list shows before "All N tasks". */
export const TASK_PAGE = 20;

/** The plan review's record: its objections, and which of them the revised plan left unanswered. */
interface PlanReview extends CritiqueRecord { readonly items: readonly { readonly id: string; readonly blocking: boolean; readonly summary: string }[] }

/** The strengths a task can need, strongest first, with a model of each for "such as …" when the lineup has none. */
const TIERS = [{ tier: "frontier", name: "Strongest model", otherwise: "Claude Opus" }, { tier: "balanced", name: "Mid model", otherwise: "Claude Sonnet" }, { tier: "fast", name: "Light model", otherwise: "Claude Haiku" }] as const;

/**
 * The plan as its saved folder has it: the hand-over first (save it, or where it was saved and what next), then the
 * questions only the person can answer, the tasks in the order of work with the model each needs and what it waits
 * for, the issues the audit could not settle (checked after the tasks), and the plan's review folded. The order of
 * work is the export's own (`GET /handoff/runs/:id/outline`), so the page and the README never disagree.
 */
export function PlanTab({ runId, overview, artifacts, refreshKey, selectedTask, onSelectTask }: {
  readonly runId: string; readonly overview: RunOverview | null; readonly artifacts: readonly ArtifactDescriptor[]; readonly refreshKey: unknown;
  readonly selectedTask: string | null; readonly onSelectTask: (taskId: string) => void;
}): ReactElement {
  const { runs, artifacts: api } = useApis();
  const plan = useRunArtifact<PersistedPlan>(api, runId, RUN_ARTIFACT_KINDS.plan, refreshKey);
  const outline = useLoaded(`plan-outline:${runId}`, () => runs.planOutline(runId), refreshKey);
  const critique = useRunArtifact<PlanReview>(api, artifacts.some(({ kind }) => kind === RUN_ARTIFACT_KINDS.criticFeedback) ? runId : null, RUN_ARTIFACT_KINDS.criticFeedback, refreshKey).value;
  if (plan.value === null) return <p className="state" data-state={plan.state === "error" ? "degraded" : "unexamined"} role={plan.state === "loading" ? "status" : undefined}>{plan.state === "loading" ? "reading the plan" : `The plan could not be read${plan.error === null ? "" : ` (${plan.error})`}.`}</p>;
  const questions = plan.value.unresolvedQuestions.filter(({ blocking }) => blocking).length;
  return <div className="summary plan-tab">
    <PlanCard runId={runId} plan={plan.value} questions={questions} onPlanTab />
    {outline.value === null ? <p className="state" data-state={outline.error === null ? "unexamined" : "degraded"} role={outline.error === null ? "status" : undefined}>{outline.error === null ? "reading the order of work" : `The order of work could not be read (${outline.error}).`}</p>
      : <Work runId={runId} outline={outline.value} configuration={overview?.configuration ?? null} selectedTask={selectedTask} onSelectTask={onSelectTask} />}
    {critique === null || critique.items.length === 0 ? null : <details className="disclosure plan-review">
      <summary>Review of the plan · {criticWords(critique)}</summary>
      <ul className="plain-list">{critique.items.map((item) => <li className="state" data-state={item.blocking && critique.revision?.notRevisedCritiqueItemIds?.includes(item.id) === true ? "refuted" : "dissent"} key={item.id}>{item.summary}</li>)}</ul>
    </details>}
  </div>;
}

/** A Feature or Testing run's plan: the same hand-over card, then the plan as recorded, with its traceability. */
export function RecordedPlan({ runId, refreshKey, selected, onSelect }: { readonly runId: string; readonly refreshKey: unknown; readonly selected: { readonly level: TraceLevel; readonly id: string } | null; readonly onSelect: (level: TraceLevel, id: string) => void }): ReactElement {
  const { artifacts: api } = useApis();
  const plan = useRunArtifact<PersistedPlan>(api, runId, RUN_ARTIFACT_KINDS.plan, refreshKey).value;
  return <div className="summary plan-tab">
    {plan === null ? null : <PlanCard runId={runId} plan={plan} questions={plan.unresolvedQuestions.filter(({ blocking }) => blocking).length} onPlanTab />}
    <PlanView api={api} runId={runId} refreshKey={refreshKey} selected={selected} onSelect={onSelect} />
  </div>;
}

function Work({ runId, outline, configuration, selectedTask, onSelectTask }: { readonly runId: string; readonly outline: PlanOutline; readonly configuration: Readonly<Record<string, unknown>> | null; readonly selectedTask: string | null; readonly onSelectTask: (taskId: string) => void }): ReactElement {
  const [all, setAll] = useState(false);
  const blocking = outline.questions.filter(({ blocking: isBlocking }) => isBlocking);
  const open = outline.questions.length - blocking.length;
  const selectedIndex = outline.tasks.findIndex(({ id }) => id === selectedTask);
  const shown = all || selectedIndex >= TASK_PAGE ? outline.tasks : outline.tasks.slice(0, TASK_PAGE);
  let step = 0;
  const heading = (words: string): string => `${step += 1} · ${words}`;
  return <>
    {outline.questions.length === 0 ? null : <section aria-labelledby="plan-questions-title" className="summary-section">
      <h2 className="panel-title" id="plan-questions-title">{heading(`Answer first · ${counted(blocking.length, "question")}`)}</h2>
      {blocking.length === 0 ? <p className="note">No question blocks the tasks.</p>
        : <ul className="plan-questions">{blocking.map(({ id, question }) => <li className="prose" key={id}>{question}</li>)}</ul>}
      {open === 0 ? null : <details className="disclosure">
        <summary>{counted(open, "more question")} the plan went ahead on with a default</summary>
        <ul className="plain-list plan-questions--open">{outline.questions.filter(({ blocking: isBlocking }) => !isBlocking).map(({ id, question }) => <li className="prose" key={id}>{question}</li>)}</ul>
      </details>}
    </section>}
    <section aria-labelledby="plan-tasks-title" className="summary-section">
      <h2 className="panel-title" id="plan-tasks-title">{heading(`Fix, in this order · ${counted(outline.tasks.length, "task")}`)}</h2>
      <ul aria-label="tasks by the model they need" className="tiers">{TIERS.map(({ tier, name, otherwise }) => {
        const count = outline.tasks.filter((task) => task.tier === tier).length;
        const folder = outline.tasks.find((task) => task.tier === tier)?.folder;
        const own = modelsOfTier(configuration, tier);
        return <li className="tier" key={tier}><span className="tier__name">{name} · {count.toLocaleString("en")}</span><span className="tier__hint">such as {own.length === 0 ? otherwise : own.join(" or ")}{folder === undefined ? "" : ` · prompts/${folder}`}</span></li>;
      })}</ul>
      <p className="note">"After" means a task builds on that one's change. "Same files as" only means both edit a file: such tasks can be done side by side and merged one after the other.</p>
      <ol className="plan-tasks-list">{shown.map((task, index) => <li className="plan-task" data-selected={task.id === selectedTask} key={task.id}>
        <span className="plan-task__n">{index + 1}</span>
        <span className="plan-task__id">{task.id}</span>
        <button aria-pressed={task.id === selectedTask} className="plan-task__title" type="button" onClick={() => onSelectTask(task.id)}>{task.title}</button>
        <span className="plan-task__facts">{[tierWord(task.tier), ...task.after.length === 0 ? [] : [`after ${task.after.join(", ")}`], ...task.sameFilesAs.length === 0 ? [] : [`same files as ${task.sameFilesAs.join(", ")}`]].join(" · ")}</span>
      </li>)}</ol>
      {shown.length < outline.tasks.length ? <button className="link-button more-link" type="button" onClick={() => setAll(true)}>All {outline.tasks.length.toLocaleString("en")} tasks</button> : null}
    </section>
    {outline.checks.length === 0 ? null : <section aria-labelledby="plan-checks-title" className="summary-section">
      <h2 className="panel-title" id="plan-checks-title">{heading(`Check after the tasks · ${counted(outline.checks.length, "issue")}`)}</h2>
      <p className="note">The audit could not settle these, and most such issues do not hold. Each prompt in prompts/{outline.checksFolder} asks your strongest model to decide whether the defect is real, and to fix it only if a test or a run shows it.</p>
      <ul className="plan-checks">{outline.checks.map(({ candidateId, title, severity }) => <li data-severity={severity} key={candidateId}>
        <span className="plan-checks__severity">{severityWord(severity)}</span>
        <Link to={{ page: "run", runId, tab: "issues", item: `issue:${candidateId}` }}>{title}</Link>
      </li>)}</ul>
    </section>}
    {outline.alsoFound === 0 && outline.unverified === 0 ? null : <p className="note">{[
      ...outline.alsoFound === 0 ? [] : [`${counted(outline.alsoFound, "more issue")} the check confirmed ${outline.alsoFound === 1 ? "has" : "have"} no task; the saved folder lists ${outline.alsoFound === 1 ? "it" : "them"} in also-found.md.`],
      ...outline.unverified === 0 ? [] : [`${counted(outline.unverified, "lower-severity issue")} ${outline.unverified === 1 ? "was" : "were"} not checked and ${outline.unverified === 1 ? "is" : "are"} not planned.`]].join(" ")}</p>}
  </>;
}
