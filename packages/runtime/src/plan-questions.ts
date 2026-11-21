import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { CheckpointResponseError } from "@arbitra/core/runner/graph-checkpoints.js";
import { PLAN_QUESTIONS_CHECKPOINT_ID, planQuestionAnswersSchema } from "@arbitra/schemas/checkpoint-policy.js";
import type { PlanIR, QuestionSuggestion, UnresolvedQuestion } from "@arbitra/schemas/plan.js";
import type { RunStore } from "./run-store.js";

type BlastRadius = UnresolvedQuestion["blastRadius"];

/**
 * The answer check of one version of a plan (`answer-check.ts`): whether a model of another vendor answered the plan's
 * blocking questions on its own, and what it answered. `answered`: it did. `off`: the run switched the check off.
 * `no_other_vendor`: the lineup has no model of another vendor than the planner's. `nothing_to_check`: no blocking
 * question carries a suggestion to compare with. `skipped`: the other model could not answer now (its vendor was out,
 * limited or failed), and the run went on without it; `reason` says why.
 */
export interface AnswerCheck {
  readonly version: string;
  readonly status: "answered" | "off" | "no_other_vendor" | "nothing_to_check" | "skipped";
  readonly profile?: string;
  readonly reason?: string;
  readonly answers?: readonly CheckedAnswer[];
}
/** The other model's answer to one question: one of its suggestion's choices (`choice`, an index), or its own (null). */
export interface CheckedAnswer { readonly questionId: string; readonly choice: number | null; readonly answer: string; readonly reason: string; readonly blastRadius: BlastRadius }

/** What the other model answered to one question, as one of the question's choices, and whether it is the suggestion. */
export interface QuestionCheck { readonly answer: string; readonly reason: string; readonly choice: number; readonly blastRadius: BlastRadius; readonly agrees: boolean; readonly profile?: string }

export interface PlanQuestion {
  readonly id: string; readonly question: string; readonly blastRadius: string;
  /** The answer the planner recommends and why; absent when its planner made no suggestion (a run pinned at planner 1.0.0). */
  readonly suggestion?: { readonly answer: string; readonly reason: string };
  /** The answers to choose from: the suggestion first, then the others the planner weighed, then the other model's own
   * answer when it is none of them. */
  readonly choices?: readonly string[];
  readonly check?: QuestionCheck;
  /** "Accept all suggested" takes this question's suggestion: both models proposed it, and neither rates the blast
   * radius of a wrong answer high. Every other question is answered one by one: people shown a wrong suggestion
   * tend to follow it. */
  readonly acceptable?: boolean;
}

/** One version of the checkpoint: the blocking questions of one exact plan. */
export interface PlanQuestionsRecord {
  readonly schemaVersion: 1;
  readonly checkpointId: typeof PLAN_QUESTIONS_CHECKPOINT_ID;
  /** Hash of the plan whose questions are asked; a changed plan is a new version. */
  readonly version: string;
  readonly questions: readonly PlanQuestion[];
  /** Whether a model of another vendor answered the questions too, which one, or why not. Records made before the
   * check have none. */
  readonly check?: { readonly status: AnswerCheck["status"]; readonly profile?: string; readonly reason?: string };
}

export interface PlanQuestionsCheckpointResource extends PlanQuestionsRecord {
  readonly kind: "plan-questions";
  readonly status: "pending" | "answered";
}

/** How an answer was given: the planner's suggestion taken, another of the listed answers chosen, or written out. */
export type AnswerHow = "as_suggested" | "chosen_otherwise" | "written";
/** One recorded answer. `together`: taken by "accept all suggested", not one by one. Answers recorded before this
 * say nothing of how they were given. */
export interface RecordedAnswer { readonly questionId: string; readonly answer: string; readonly how?: AnswerHow; readonly together?: true }
export interface RecordedAnswers { readonly version: string; readonly answers: readonly RecordedAnswer[] }
/** An answered question as a round of answers records it, for the plan's revision and the saved plan's questions.md. */
export interface AnsweredQuestion extends RecordedAnswer { readonly question: string; readonly blastRadius?: string; readonly suggestion?: PlanQuestion["suggestion"]; readonly check?: QuestionCheck }

const CURRENT_KIND = "plan-questions-checkpoint";

/** The version of a plan's questions: the hash of the exact plan. */
export function planQuestionsVersion(plan: PlanIR): string { return createHash("sha256").update(canonicalJson(plan)).digest("hex"); }

/** A suggestion's answers to choose from, the recommended first, each once. */
export function choicesOf(suggestion: QuestionSuggestion): readonly string[] {
  return [...new Set([suggestion.answer, ...suggestion.alternatives].map((answer) => answer.trim()).filter((answer) => answer !== ""))];
}

/** The choice a written answer is, when it is one of them word for word (case and surrounding space aside). */
function choiceOf(choices: readonly string[] | undefined, text: string): number | undefined {
  const index = (choices ?? []).findIndex((choice) => choice.trim().toLowerCase() === text.trim().toLowerCase());
  return index < 0 ? undefined : index;
}

/**
 * The checkpoint's view of blocking questions: each with the planner's suggestion, the answers to choose from, what the
 * other model answered on its own, and whether "accept all suggested" may take it.
 */
export function questionEntries(questions: readonly UnresolvedQuestion[], check?: AnswerCheck): readonly PlanQuestion[] {
  return questions.map(({ id, question, blastRadius, suggestion }): PlanQuestion => {
    if (suggestion === undefined) return { id, question, blastRadius };
    const offered = choicesOf(suggestion);
    const checked = check?.status === "answered" ? check.answers?.find(({ questionId }) => questionId === id) : undefined;
    if (checked === undefined) return { id, question, blastRadius, suggestion: { answer: suggestion.answer, reason: suggestion.reason }, choices: offered, acceptable: false };
    const known = checked.choice !== null && checked.choice < offered.length ? checked.choice : choiceOf(offered, checked.answer);
    const choices = known === undefined ? [...offered, checked.answer.trim()] : offered;
    const at = known ?? offered.length;
    const entry: QuestionCheck = { answer: choices[at] ?? checked.answer, reason: checked.reason, choice: at, blastRadius: checked.blastRadius, agrees: at === 0, ...(check?.profile === undefined ? {} : { profile: check.profile }) };
    return { id, question, blastRadius, suggestion: { answer: suggestion.answer, reason: suggestion.reason }, choices, check: entry,
      acceptable: entry.agrees && blastRadius !== "high" && entry.blastRadius !== "high" };
  });
}

/** The answered questions of one round, as its record keeps them: what was asked, suggested and checked, and how it was answered. */
export function answeredQuestions(record: PlanQuestionsRecord, response: RecordedAnswers): readonly AnsweredQuestion[] {
  return record.questions.map(({ id, question, blastRadius, suggestion, check }) => {
    const given = response.answers.find(({ questionId }) => questionId === id);
    return { questionId: id, question, answer: given?.answer ?? "", ...(given?.how === undefined ? {} : { how: given.how }), ...(given?.together === true ? { together: true as const } : {}),
      blastRadius, ...(suggestion === undefined ? {} : { suggestion }), ...(check === undefined ? {} : { check }) };
  });
}

/**
 * The durable checkpoint where an interactive Audit waits for answers to its plan's blocking
 * questions. Observed live: an Audit plan correctly left "throw or clamp?" open and failed its
 * gate, with no way to answer it and resume. Each version accepts one complete set of answers.
 */
export class PlanQuestionsCheckpoint {
  constructor(private readonly store: RunStore) {}

  /**
   * Records the plan's blocking questions as the current version, with the answer check of that plan. The same plan
   * keeps its version and the record its answers were given against.
   */
  async open(plan: PlanIR, check?: AnswerCheck): Promise<PlanQuestionsRecord> {
    const version = planQuestionsVersion(plan);
    const stored = await this.current();
    if (stored?.version === version) return stored;
    const record: PlanQuestionsRecord = { schemaVersion: 1, checkpointId: PLAN_QUESTIONS_CHECKPOINT_ID, version,
      questions: questionEntries(plan.unresolvedQuestions.filter(({ blocking }) => blocking), check),
      ...(check === undefined ? {} : { check: { status: check.status, ...(check.profile === undefined ? {} : { profile: check.profile }), ...(check.reason === undefined ? {} : { reason: check.reason }) } }) };
    await this.store.publish(CURRENT_KIND, record, "planner");
    return record;
  }

  async current(): Promise<PlanQuestionsRecord | null> {
    const descriptor = (await this.store.listArtifacts()).find(({ kind }) => kind === CURRENT_KIND);
    return descriptor === undefined ? null : this.store.artifacts.get<PlanQuestionsRecord>(descriptor.ref);
  }

  answers(version: string): Promise<RecordedAnswers | null> { return this.store.readOnce<RecordedAnswers>([PLAN_QUESTIONS_CHECKPOINT_ID, version]); }

  async view(): Promise<PlanQuestionsCheckpointResource | null> {
    const record = await this.current();
    return record === null ? null : { ...record, kind: "plan-questions", status: await this.answers(record.version) === null ? "pending" : "answered" };
  }

  /**
   * Accepts answers only for the current version, exactly once, answering every question exactly once: one by one, as
   * one of its listed answers (`choice`) or written out, or, with `acceptSuggested`, together for every question
   * marked acceptable that the answers leave out. Records how each answer was given.
   */
  async respond(value: unknown): Promise<RecordedAnswers> {
    const parsed = planQuestionAnswersSchema.safeParse(value);
    if (!parsed.success) throw Object.assign(new Error("PLAN_QUESTION_ANSWERS_INVALID: answers are {version, answers: [{questionId, answer} or {questionId, choice}], acceptSuggested?: true}"), { statusCode: 400 });
    const response = parsed.data;
    const current = await this.current();
    if (current === null) throw new CheckpointResponseError("CHECKPOINT_NOT_FOUND", 404);
    if (current.version !== response.version) throw new CheckpointResponseError("STALE_CHECKPOINT", 409);
    const asked = current.questions.map(({ id }) => id);
    const given = response.answers.map(({ questionId }) => questionId);
    const together = response.acceptSuggested === true ? current.questions.filter(({ id, acceptable }) => acceptable === true && !given.includes(id)).map(({ id }) => id) : [];
    const unanswered = asked.filter((id) => !given.includes(id) && !together.includes(id));
    const unknown = given.filter((id) => !asked.includes(id));
    if (unanswered.length > 0 || unknown.length > 0 || new Set(given).size !== given.length) {
      const oneByOne = unanswered.length > 0 && response.acceptSuggested === true ? " (accept all suggested takes only the questions both models answered alike whose blast radius is not high; answer the others one by one)" : "";
      throw Object.assign(new Error(`PLAN_QUESTION_ANSWERS_INVALID: answer each of ${asked.join(", ")} exactly once${unanswered.length === 0 ? "" : `; unanswered: ${unanswered.join(", ")}${oneByOne}`}${unknown.length === 0 ? "" : `; unknown: ${unknown.join(", ")}`}`), { statusCode: 400 });
    }
    const answers = current.questions.map(({ id, choices }): RecordedAnswer => {
      const answer = response.answers.find(({ questionId }) => questionId === id);
      if (answer === undefined) return { questionId: id, answer: choices?.[0] ?? "", how: "as_suggested", together: true };
      if ("choice" in answer) {
        const chosen = choices?.[answer.choice];
        if (chosen === undefined) throw Object.assign(new Error(`PLAN_QUESTION_CHOICE_INVALID: ${id} lists ${choices?.length ?? 0} answers to choose from; write the answer instead`), { statusCode: 400 });
        return { questionId: id, answer: chosen, how: answer.choice === 0 ? "as_suggested" : "chosen_otherwise" };
      }
      const index = choiceOf(choices, answer.answer);
      return index === undefined ? { questionId: id, answer: answer.answer.trim(), how: "written" } : { questionId: id, answer: choices?.[index] ?? answer.answer.trim(), how: index === 0 ? "as_suggested" : "chosen_otherwise" };
    });
    const recorded: RecordedAnswers = { version: response.version, answers };
    if (!await this.store.createOnce([PLAN_QUESTIONS_CHECKPOINT_ID, response.version], recorded)) throw new CheckpointResponseError("CHECKPOINT_ALREADY_DECIDED", 409);
    return recorded;
  }
}

/** How an answer was given, in the saved plan's words. */
const HOW: Readonly<Record<AnswerHow, string>> = Object.freeze({ as_suggested: "taken as suggested", chosen_otherwise: "chosen over the suggestion", written: "written by the person" });

/** What the other model said of one question, as a line of the saved plan. */
function checkLine(check: QuestionCheck | undefined, checked: AnswerCheck | undefined): string | null {
  if (check !== undefined) return `- Another model${check.profile === undefined ? "" : ` (${check.profile})`}: ${check.agrees ? "proposed the same answer" : `answered "${check.answer}"`}. ${check.reason}${check.blastRadius === "high" ? " It rates a wrong answer's blast radius high." : ""}`;
  if (checked === undefined || checked.status === "answered") return null;
  const why = checked.status === "off" ? "the run switched the check off" : checked.status === "no_other_vendor" ? "the run had no model of another vendor than the planner's"
    : checked.status === "nothing_to_check" ? "no question carried a suggestion" : `it could not answer then (${checked.reason ?? "no reason recorded"})`;
  return `- Another model: not asked, because ${why}.`;
}

/**
 * The saved plan's `questions.md`: the blocking questions answered while the plan was written, each with its suggestion,
 * the other model's answer and how it was answered; the blocking questions still open, the same way, saying which
 * can be taken as suggested together; and the questions that do not block, with the default the plan went ahead on.
 * Null when the plan has none of them.
 */
export function questionsMarkdown(open: readonly UnresolvedQuestion[], answered: readonly AnsweredQuestion[], check?: AnswerCheck): string | null {
  const blocking = open.filter(({ blocking: isBlocking }) => isBlocking);
  const others = open.filter(({ blocking: isBlocking }) => !isBlocking);
  if (blocking.length === 0 && others.length === 0 && answered.length === 0) return null;
  const entries = questionEntries(blocking, check);
  // The answers the planner weighed: its own choices, without an answer of the other model's added after them.
  const suggestionLines = ({ suggestion }: UnresolvedQuestion) => suggestion === undefined ? ["- Suggested: none; the planner made no suggestion."]
    : [`- Suggested: ${suggestion.answer} ${suggestion.reason}`, ...(choicesOf(suggestion).length > 1 ? [`- Answers weighed: ${choicesOf(suggestion).map((choice) => `"${choice}"`).join("; ")}`] : [])];
  const acceptable = entries.filter(({ acceptable: ok }) => ok === true).length;
  return ["# Questions", "",
    ...(answered.length === 0 ? [] : ["## Answered while the plan was written", "",
      "The plan's tasks already follow these answers.", "",
      ...answered.flatMap(({ questionId, question, answer, how, together, blastRadius, suggestion, check: checked }) => [`### ${questionId}${blastRadius === undefined ? "" : ` · ${blastRadius} impact`}`, "", question, "",
        `- Answer: ${answer}${how === undefined ? "" : ` (${HOW[how]}${together === true ? ", with the other suggestions both models agreed on" : ", one by one"})`}`,
        ...(suggestion === undefined ? [] : [`- Suggested: ${suggestion.answer} ${suggestion.reason}`]), ...(checked === undefined ? [] : [checkLine(checked, undefined) ?? ""]), ""])]),
    ...(blocking.length === 0 ? [] : ["## Answer these first", "",
      `They block the tasks that depend on them.${acceptable === 0 ? "" : ` Both models proposed the same answer to ${acceptable === 1 ? "one of them" : `${acceptable} of them`}, with a blast radius below high: ${acceptable === 1 ? "it is" : "those are"} marked, and can be taken as suggested together. Answer the others one by one: a suggestion is easy to follow when it is wrong.`}`, "",
      ...entries.flatMap(({ id, question, blastRadius, check: checked, acceptable: ok }, index) => [`### ${id}${blastRadius === undefined ? "" : ` · ${blastRadius} impact`}${ok === true ? " · both models agree" : ""}`, "", question, "",
        ...suggestionLines(blocking[index] as UnresolvedQuestion), ...[checkLine(checked, check)].filter((line): line is string => line !== null), ""])]),
    ...(others.length === 0 ? [] : ["## Open questions", "",
      "Not blocking: the plan went ahead on each one's default. Answer one to change what the tasks that cite it do; each prompt repeats the questions it depends on.", "",
      ...others.map(({ id, question, suggestion }) => `- **${id}**: ${question}${suggestion === undefined ? "" : ` Default: ${suggestion.answer}`}`), ""])].join("\n");
}
