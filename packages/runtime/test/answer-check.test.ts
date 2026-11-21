import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { modelPlanRevisionSchema } from "@arbitra/schemas/model-results.js";
import { planRevisionPatchSchema } from "@arbitra/schemas/plan-revision-patch.js";
import { planIRSchema, type PlanIR, type UnresolvedQuestion } from "@arbitra/schemas/plan.js";
import { plannerBriefSchema, plannerOutlineSchema, plannerTaskExpansionSchema } from "@arbitra/schemas/planner-composition.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { answerCheckRequest, answerCheckSetting, plannerOutputSchema, questionsToCheck } from "../src/answer-check.js";
import { answerCheckerProfile } from "../src/audit-roles.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("planner output schemas", () => {
  // The schemas planner 1.0.0 sent before questions carried suggestions. Each is in a recorded call's system prompt, so a
  // changed byte would refuse to resume every run pinned at 1.0.0 (MODEL_ACTIVITY_INPUT_CHANGED).
  const recorded = [
    ["plan", planIRSchema, "41568e25971413e2d5884ed1f56dc2854e0802ed96111fdf55122c02d38ad819"],
    ["brief", plannerBriefSchema, "02b832df1302794e1e156e3d64a4158fafcb1751c356e33d7ffe6eb592a8e61d"],
    ["outline", plannerOutlineSchema, "aec2d2cb0a5d6e4ba84e079189f1888ba3a7696e306c62b05832ec0dc3244fef"],
    ["task expansion", plannerTaskExpansionSchema, "771878504d3fd86f977641b25c79405b5828c578bd788ab362cbcab6b0236e62"],
    ["revision", modelPlanRevisionSchema, "e9aedf9d77586e662a8413479219e32df63fc70ed4f3e9310604bc4c1a3ebbf8"],
    ["revision patch", planRevisionPatchSchema, "26cff621c98529a5cc6e1b417194737728d8f04754e7e2f89299400fce19d288"],
  ] as const;

  it.each(recorded)("sends the %s schema of planner 1.0.0 byte for byte", (_, schema, expected) => {
    expect(hash(plannerOutputSchema(schema.toJSONSchema(), "1.0.0"))).toBe(expected);
  });

  it.each(recorded)("asks every question of the %s schema for a suggestion from planner 1.1.0", (_, schema) => {
    const sent = JSON.stringify(plannerOutputSchema(schema.toJSONSchema(), "1.1.0"));
    const questions = [...sent.matchAll(/"blastRadius":\{[^}]*\},"suggestion":\{/gu)].length;
    expect(questions).toBeGreaterThan(0);
    expect([...sent.matchAll(/"required":\["id","question","blocking","blastRadius","suggestion"\]/gu)].length).toBe(questions);
  });
});

async function plan(): Promise<PlanIR> {
  return planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
}

describe("the answer check's request", () => {
  const question = (id: string, overrides: Partial<UnresolvedQuestion> = {}): UnresolvedQuestion => ({ id, question: `Throw or clamp in ${id}?`, blocking: true, blastRadius: "medium",
    suggestion: { answer: "Throw a RangeError", reason: "Callers already catch it.", alternatives: ["Clamp to the bounds", "Return null"] }, ...overrides });

  it("shows the answers the planner weighed in an order that does not give its pick away, and nothing of its reason", async () => {
    const base = await plan();
    const task = base.tasks[0] as PlanIR["tasks"][number];
    const linked = { ...base, tasks: [{ ...task, goal: { ...task.goal, objective: `${task.goal.objective} See Q-1.` } }] };
    const request = answerCheckRequest(linked, [question("Q-1")], []);
    const sent = request.input as { questions: { questionId: string; options: { label: string; answer: string }[]; dependingTaskIds: string[] }[] };
    expect(sent.questions[0]?.options).toEqual([{ label: "A", answer: "Clamp to the bounds" }, { label: "B", answer: "Return null" }, { label: "C", answer: "Throw a RangeError" }]);
    expect(sent.questions[0]?.dependingTaskIds).toEqual([task.id]);
    expect(JSON.stringify(request.input)).not.toContain("Callers already catch it.");
    expect(JSON.stringify(request.input)).not.toContain("blastRadius");
    expect(request.citedPaths).toEqual([...new Set([...task.scope.likelyFiles, ...task.readFirst])]);
  });

  it("maps a label back to the planner's choice, and keeps an answer of its own", async () => {
    const request = answerCheckRequest(await plan(), [question("Q-1"), question("Q-2")], []);
    expect(request.parse({ answers: [
      { questionId: "Q-1", option: "c", answer: "Throw", reason: "It is what callers expect.", blastRadius: "low" },
      { questionId: "Q-2", option: "none", answer: "Log and skip the record", reason: "Neither fits a batch import.", blastRadius: "high" },
    ] })).toEqual([
      { questionId: "Q-1", choice: 0, answer: "Throw", reason: "It is what callers expect.", blastRadius: "low" },
      { questionId: "Q-2", choice: null, answer: "Log and skip the record", reason: "Neither fits a batch import.", blastRadius: "high" },
    ]);
  });

  it("refuses a reply that leaves a question out, answers one twice or names an option there is not", async () => {
    const request = answerCheckRequest(await plan(), [question("Q-1"), question("Q-2")], []);
    const answer = (questionId: string, option = "A") => ({ questionId, option, answer: "Clamp", reason: "Simple.", blastRadius: "low" });
    expect(() => request.parse({ answers: [answer("Q-1")] })).toThrow(/ANSWER_CHECK_INCOMPLETE.*Q-2/u);
    expect(() => request.parse({ answers: [answer("Q-1"), answer("Q-1"), answer("Q-2")] })).toThrow(/ANSWER_CHECK_QUESTION_REPEATED/u);
    expect(() => request.parse({ answers: [answer("Q-1", "D"), answer("Q-2")] })).toThrow(/ANSWER_CHECK_OPTION_UNKNOWN/u);
    expect(() => request.parse({ answers: [answer("Q-1"), answer("Q-2"), answer("Q-3")] })).toThrow(/ANSWER_CHECK_QUESTION_UNKNOWN/u);
  });

  it("checks only the blocking questions that carry a suggestion", () => {
    const questions = [question("Q-1"), question("Q-2", { blocking: false }), { id: "Q-3", question: "Which?", blocking: true, blastRadius: "low" as const }];
    expect(questionsToCheck({ unresolvedQuestions: questions }).map(({ id }) => id)).toEqual(["Q-1"]);
  });
});

describe("the answer checker", () => {
  const models = { opus: { provider: "anthropic", transport: "claude-code-cli" }, sonnet: { provider: "anthropic", transport: "claude-code-cli" }, gpt: { provider: "openai", transport: "codex-cli" },
    gemini: { provider: "google", transport: "antigravity-cli" }, flash: { provider: "other", transport: "gemini-native" } } as const;

  it("is a model of another vendor than the planner's: the critic, else the second opinion, else a finder", () => {
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus", critic: "gpt" }, ["sonnet", "gemini"], models)).toBe("gpt");
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus", secondOpinion: "gpt" }, ["gemini"], models)).toBe("gpt");
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus", answerChecker: "gemini", critic: "gpt" }, [], models)).toBe("gemini");
  });

  it("is never Gemini unless the run names it: answering the plan's questions is planning", () => {
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus", critic: "sonnet" }, ["sonnet", "gemini"], models)).toBeUndefined();
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus", critic: "gemini" }, ["sonnet", "gemini", "gpt"], models)).toBe("gpt");
    // Told apart by its transport too, whatever its provider says.
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus" }, ["sonnet", "flash"], models)).toBeUndefined();
  });

  it("is none when the lineup has no other vendor, or the named one is the planner's", () => {
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus", critic: "sonnet" }, ["opus", "sonnet"], models)).toBeUndefined();
    expect(answerCheckerProfile({ planner: "opus", verifier: "opus", answerChecker: "sonnet" }, ["gpt"], models)).toBeUndefined();
  });

  it("is switched on unless the run switches it off, and off without another vendor", () => {
    const config = (workflow: Record<string, unknown>) => ({ models, workflow }) as unknown as RunConfig;
    const roles = { planner: "opus", verifier: "opus", critic: "gpt" };
    expect(answerCheckSetting(config({}), roles, ["opus"])).toEqual({ on: true, profile: "gpt" });
    expect(answerCheckSetting(config({ answerCheck: true }), roles, ["opus"])).toEqual({ on: true, profile: "gpt" });
    expect(answerCheckSetting(config({ answerCheck: false }), roles, ["opus"])).toEqual({ on: false, reason: "off" });
    expect(answerCheckSetting(config({}), { planner: "opus", verifier: "opus" }, ["sonnet"])).toEqual({ on: false, reason: "no_other_vendor" });
  });
});
