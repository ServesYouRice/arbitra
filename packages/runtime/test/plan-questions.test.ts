import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planIRSchema, type PlanIR, type UnresolvedQuestion } from "@arbitra/schemas/plan.js";
import { planQuestionAnswersSchema } from "@arbitra/schemas/checkpoint-policy.js";
import type { Orchestrator } from "../src/orchestrator.js";
import { answerCheckKind } from "../src/answer-check.js";
import { exportPlan } from "../src/plan-export.js";
import { PlanQuestionsCheckpoint, planQuestionsVersion, questionEntries, questionsMarkdown, type AnswerCheck, type CheckedAnswer } from "../src/plan-questions.js";
import { RunStore } from "../src/run-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const question = (id: string, blastRadius: UnresolvedQuestion["blastRadius"], alternatives: readonly string[] = ["Clamp to the bounds."]): UnresolvedQuestion => ({
  id, question: `Throw or clamp in ${id}?`, blocking: true, blastRadius, suggestion: { answer: "Throw a RangeError.", reason: "Callers already catch it.", alternatives: [...alternatives] } });
const answered = (version: string, answers: readonly CheckedAnswer[]): AnswerCheck => ({ version, status: "answered", profile: "gpt", answers });

describe("the plan's questions as the checkpoint asks them", () => {
  it("may take a suggestion together only when the other model proposed it and neither rates a wrong answer's blast radius high", () => {
    const entries = questionEntries([question("Q-1", "medium"), question("Q-2", "high"), question("Q-3", "low"), question("Q-4", "low"), question("Q-5", "low")], answered("v", [
      { questionId: "Q-1", choice: 0, answer: "Throw.", reason: "Callers catch it.", blastRadius: "low" },
      { questionId: "Q-2", choice: 0, answer: "Throw.", reason: "Callers catch it.", blastRadius: "low" },
      { questionId: "Q-3", choice: 0, answer: "Throw.", reason: "It touches stored data.", blastRadius: "high" },
      { questionId: "Q-4", choice: 1, answer: "Clamp.", reason: "Input is noisy.", blastRadius: "low" },
      // Its own words for one of the planner's answers count as that answer.
      { questionId: "Q-5", choice: null, answer: " throw a rangeerror. ", reason: "Callers catch it.", blastRadius: "low" },
    ]));
    expect(entries.map(({ id, acceptable, check }) => [id, acceptable, check?.agrees])).toEqual([["Q-1", true, true], ["Q-2", false, true], ["Q-3", false, true], ["Q-4", false, false], ["Q-5", true, true]]);
    expect(entries[3]).toMatchObject({ choices: ["Throw a RangeError.", "Clamp to the bounds."], check: { choice: 1, answer: "Clamp to the bounds.", reason: "Input is noisy.", profile: "gpt" } });
  });

  it("lists an answer of the other model's own after the planner's, and takes nothing together without a check", () => {
    const [own] = questionEntries([question("Q-1", "low")], answered("v", [{ questionId: "Q-1", choice: null, answer: "Return null.", reason: "Readers expect it.", blastRadius: "medium" }]));
    expect(own).toMatchObject({ choices: ["Throw a RangeError.", "Clamp to the bounds.", "Return null."], check: { choice: 2, agrees: false }, acceptable: false });
    for (const check of [undefined, { version: "v", status: "skipped", profile: "gpt", reason: "quota" } as const]) {
      expect(questionEntries([question("Q-1", "low")], check)[0]).toEqual({ id: "Q-1", question: "Throw or clamp in Q-1?", blastRadius: "low", suggestion: { answer: "Throw a RangeError.", reason: "Callers already catch it." }, choices: ["Throw a RangeError.", "Clamp to the bounds."], acceptable: false });
    }
    // A question its planner made no suggestion for (planner 1.0.0) is asked as it was.
    expect(questionEntries([{ id: "Q-1", question: "Which?", blocking: true, blastRadius: "low" }])[0]).toEqual({ id: "Q-1", question: "Which?", blastRadius: "low" });
  });
});

async function checkpoint(questions: readonly UnresolvedQuestion[], check?: (version: string) => AnswerCheck) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-plan-questions-")); directories.push(root);
  const template = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const plan: PlanIR = { ...template, unresolvedQuestions: [...questions] };
  const points = new PlanQuestionsCheckpoint(new RunStore(root, "run-1"));
  const record = await points.open(plan, check?.(planQuestionsVersion(plan)));
  return { points, record };
}

describe("answers to the plan's questions", () => {
  it("takes together the questions marked acceptable, one by one the rest, and records how each was given", async () => {
    const { points, record } = await checkpoint([question("Q-1", "low"), question("Q-2", "high"), question("Q-3", "low", ["Clamp.", "Wrap around."])], (version) => answered(version, [
      { questionId: "Q-1", choice: 0, answer: "Throw.", reason: "Callers catch it.", blastRadius: "low" },
      { questionId: "Q-2", choice: 0, answer: "Throw.", reason: "Callers catch it.", blastRadius: "low" },
      { questionId: "Q-3", choice: 0, answer: "Throw.", reason: "Callers catch it.", blastRadius: "low" },
    ]));
    expect(record.check).toEqual({ status: "answered", profile: "gpt" });
    // Q-2's blast radius is high, so it is answered one by one even though both models agree.
    await expect(points.respond({ version: record.version, answers: [], acceptSuggested: true })).rejects.toThrow(/unanswered: Q-2 \(accept all suggested takes only/u);
    await expect(points.respond({ version: record.version, answers: [{ questionId: "Q-2", choice: 5 }], acceptSuggested: true })).rejects.toThrow("PLAN_QUESTION_CHOICE_INVALID: Q-2 lists 2 answers");
    // A question answered one by one is not also taken together.
    const recorded = await points.respond({ version: record.version, answers: [{ questionId: "Q-2", choice: 1 }, { questionId: "Q-3", answer: "Wrap around, and log it." }], acceptSuggested: true });
    expect(recorded.answers).toEqual([
      { questionId: "Q-1", answer: "Throw a RangeError.", how: "as_suggested", together: true },
      { questionId: "Q-2", answer: "Clamp to the bounds.", how: "chosen_otherwise" },
      { questionId: "Q-3", answer: "Wrap around, and log it.", how: "written" },
    ]);
    expect(await points.answers(record.version)).toEqual(recorded);
    expect((await points.view())?.status).toBe("answered");
  });

  it("still takes answers written out, the way a checkpoint made before suggestions was answered", async () => {
    const { points, record } = await checkpoint([{ id: "Q-1", question: "Which?", blocking: true, blastRadius: "low" }]);
    await expect(points.respond({ version: record.version, answers: [{ questionId: "Q-1", choice: 0 }] })).rejects.toThrow("PLAN_QUESTION_CHOICE_INVALID: Q-1 lists 0 answers");
    expect((await points.respond({ version: record.version, answers: [{ questionId: "Q-1", answer: "  The first. " }] })).answers).toEqual([{ questionId: "Q-1", answer: "The first.", how: "written" }]);
  });

  it("refuses an empty set of answers unless it accepts the suggestions, and a choice that is not an index", () => {
    expect(planQuestionAnswersSchema.safeParse({ version: "a".repeat(64), answers: [] }).success).toBe(false);
    expect(planQuestionAnswersSchema.safeParse({ version: "a".repeat(64), answers: [], acceptSuggested: true }).success).toBe(true);
    expect(planQuestionAnswersSchema.safeParse({ version: "a".repeat(64), answers: [{ questionId: "Q-1", choice: -1 }] }).success).toBe(false);
    expect(planQuestionAnswersSchema.safeParse({ version: "a".repeat(64), answers: [{ questionId: "Q-1", choice: 0, answer: "Both." }] }).success).toBe(false);
    expect(planQuestionAnswersSchema.safeParse({ version: "a".repeat(64), answers: [{ questionId: "Q-1", answer: "  " }] }).success).toBe(false);
  });
});

describe("the saved plan's questions.md", () => {
  it("shows each question's suggestion, the other model's answer and how it was answered", async () => {
    const repository = await mkdtemp(join(tmpdir(), "arbitra-plan-questions-export-")); directories.push(repository);
    const plan = { title: "Plan", tasks: [], unresolvedQuestions: [question("Q-2", "medium"), question("Q-3", "low", ["Clamp.", "Wrap around."]), { id: "Q-4", question: "Which colour?", blocking: false, blastRadius: "low", suggestion: { answer: "Blue.", reason: "It matches.", alternatives: [] } }] };
    const version = planQuestionsVersion(plan as unknown as PlanIR);
    const content: Record<string, unknown> = {
      "plan-ir": plan, "canonical-issues": { issues: [] },
      "plan-question-resolutions": { rounds: [{ version: "earlier", answers: [
        { questionId: "Q-1", question: "Throw or clamp in Q-1?", answer: "Throw a RangeError.", how: "as_suggested", together: true, blastRadius: "low", suggestion: { answer: "Throw a RangeError.", reason: "Callers already catch it." },
          check: { answer: "Throw a RangeError.", reason: "Callers catch it.", choice: 0, blastRadius: "low", agrees: true, profile: "gpt" } },
        // A round recorded before answers said how they were given.
        { questionId: "Q-0", question: "Which way?", answer: "Left." }] }] },
      [answerCheckKind(version)]: answered(version, [
        { questionId: "Q-2", choice: 0, answer: "Throw.", reason: "Callers catch it.", blastRadius: "low" },
        { questionId: "Q-3", choice: null, answer: "Saturate.", reason: "It is what the hardware does.", blastRadius: "high" },
      ]),
    };
    const orchestrator = {
      overview: async () => ({ repository, workflowId: "audit-deep" }), repositoryMatches: async () => true, modules: async () => [],
      artifacts: async () => Object.keys(content).map((kind) => ({ kind, artifactId: kind })),
      artifact: async (_runId: string, id: string) => ({ content: JSON.stringify(content[id]) }),
    } as unknown as Orchestrator;
    const { directory } = await exportPlan(orchestrator, "run-12345678-abcd");
    const text = await readFile(join(directory, "questions.md"), "utf8");
    expect(text).toContain("## Answered while the plan was written\n\nThe plan's tasks already follow these answers.\n\n### Q-1 · low impact\n\nThrow or clamp in Q-1?\n\n- Answer: Throw a RangeError. (taken as suggested, with the other suggestions both models agreed on)\n- Suggested: Throw a RangeError. Callers already catch it.\n- Another model (gpt): proposed the same answer. Callers catch it.\n");
    expect(text).toContain("### Q-0\n\nWhich way?\n\n- Answer: Left.\n");
    expect(text).toContain("## Answer these first\n\nThey block the tasks that depend on them. Both models proposed the same answer to one of them, with a blast radius below high: it is marked, and can be taken as suggested together.");
    expect(text).toContain("### Q-2 · medium impact · both models agree\n\nThrow or clamp in Q-2?\n\n- Suggested: Throw a RangeError. Callers already catch it.\n- Answers weighed: \"Throw a RangeError.\"; \"Clamp to the bounds.\"\n- Another model (gpt): proposed the same answer. Callers catch it.\n");
    expect(text).toContain("### Q-3 · low impact\n\nThrow or clamp in Q-3?\n\n- Suggested: Throw a RangeError. Callers already catch it.\n- Answers weighed: \"Throw a RangeError.\"; \"Clamp.\"; \"Wrap around.\"\n- Another model (gpt): answered \"Saturate.\". It is what the hardware does. It rates a wrong answer's blast radius high.\n");
    expect(text).toContain("## Open questions\n\nNot blocking: the plan went ahead on each one's default.");
    expect(text).toContain("- **Q-4**: Which colour? Default: Blue.\n");
    expect(await readFile(join(directory, "README.md"), "utf8")).toContain("`questions.md` gives each one's suggested answer and the others weighed.");
  });

  it("says why no other model was asked", () => {
    const text = questionsMarkdown([question("Q-1", "low")], [], { version: "v", status: "skipped", profile: "gpt", reason: "MODEL_ROUTES_EXHAUSTED:gpt: gpt is out" });
    expect(text).toContain("- Another model: not asked, because it could not answer then (MODEL_ROUTES_EXHAUSTED:gpt: gpt is out).");
    expect(questionsMarkdown([question("Q-1", "low")], [], { version: "v", status: "no_other_vendor" })).toContain("not asked, because the run had no model of another vendor than the planner's.");
    expect(questionsMarkdown([], [])).toBeNull();
  });
});
