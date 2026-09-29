import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { CheckpointResponseError } from "@arbitra/core/runner/graph-checkpoints.js";
import { PLAN_QUESTIONS_CHECKPOINT_ID, planQuestionAnswersSchema, type PlanQuestionAnswers } from "@arbitra/schemas/checkpoint-policy.js";
import type { PlanIR } from "@arbitra/schemas/plan.js";
import type { RunStore } from "./run-store.js";

export interface PlanQuestion { readonly id: string; readonly question: string; readonly blastRadius: string }

/** One version of the checkpoint: the blocking questions of one exact plan. */
export interface PlanQuestionsRecord {
  readonly schemaVersion: 1;
  readonly checkpointId: typeof PLAN_QUESTIONS_CHECKPOINT_ID;
  /** Hash of the plan whose questions are asked; a changed plan is a new version. */
  readonly version: string;
  readonly questions: readonly PlanQuestion[];
}

export interface PlanQuestionsCheckpointResource extends PlanQuestionsRecord {
  readonly kind: "plan-questions";
  readonly status: "pending" | "answered";
}

const CURRENT_KIND = "plan-questions-checkpoint";

/**
 * The durable checkpoint where an interactive Audit waits for answers to its plan's blocking
 * questions. Observed live: an Audit plan correctly left "throw or clamp?" open and failed its
 * gate, with no way to answer it and resume. Each version accepts one complete set of answers.
 */
export class PlanQuestionsCheckpoint {
  constructor(private readonly store: RunStore) {}

  /** Records the plan's blocking questions as the current version; the same plan keeps its version. */
  async open(plan: PlanIR): Promise<PlanQuestionsRecord> {
    const record: PlanQuestionsRecord = { schemaVersion: 1, checkpointId: PLAN_QUESTIONS_CHECKPOINT_ID, version: createHash("sha256").update(canonicalJson(plan)).digest("hex"),
      questions: plan.unresolvedQuestions.filter(({ blocking }) => blocking).map(({ id, question, blastRadius }) => ({ id, question, blastRadius })) };
    if ((await this.current())?.version !== record.version) await this.store.publish(CURRENT_KIND, record, "planner");
    return record;
  }

  async current(): Promise<PlanQuestionsRecord | null> {
    const descriptor = (await this.store.listArtifacts()).find(({ kind }) => kind === CURRENT_KIND);
    return descriptor === undefined ? null : this.store.artifacts.get<PlanQuestionsRecord>(descriptor.ref);
  }

  answers(version: string): Promise<PlanQuestionAnswers | null> { return this.store.readOnce<PlanQuestionAnswers>([PLAN_QUESTIONS_CHECKPOINT_ID, version]); }

  async view(): Promise<PlanQuestionsCheckpointResource | null> {
    const record = await this.current();
    return record === null ? null : { ...record, kind: "plan-questions", status: await this.answers(record.version) === null ? "pending" : "answered" };
  }

  /** Accepts answers only for the current version, exactly once, answering every question exactly once. */
  async respond(value: unknown): Promise<PlanQuestionAnswers> {
    const parsed = planQuestionAnswersSchema.safeParse(value);
    if (!parsed.success) throw Object.assign(new Error("PLAN_QUESTION_ANSWERS_INVALID: answers are {version, answers: [{questionId, answer}]}"), { statusCode: 400 });
    const response = parsed.data;
    const current = await this.current();
    if (current === null) throw new CheckpointResponseError("CHECKPOINT_NOT_FOUND", 404);
    if (current.version !== response.version) throw new CheckpointResponseError("STALE_CHECKPOINT", 409);
    const asked = current.questions.map(({ id }) => id);
    const given = response.answers.map(({ questionId }) => questionId);
    const unanswered = asked.filter((id) => !given.includes(id));
    const unknown = given.filter((id) => !asked.includes(id));
    if (unanswered.length > 0 || unknown.length > 0 || new Set(given).size !== given.length) {
      throw Object.assign(new Error(`PLAN_QUESTION_ANSWERS_INVALID: answer each of ${asked.join(", ")} exactly once${unanswered.length === 0 ? "" : `; unanswered: ${unanswered.join(", ")}`}${unknown.length === 0 ? "" : `; unknown: ${unknown.join(", ")}`}`), { statusCode: 400 });
    }
    if (!await this.store.createOnce([PLAN_QUESTIONS_CHECKPOINT_ID, response.version], response)) throw new CheckpointResponseError("CHECKPOINT_ALREADY_DECIDED", 409);
    return response;
  }
}
