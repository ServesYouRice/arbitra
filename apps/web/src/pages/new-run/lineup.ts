import { effortFor, modelName, PLACEHOLDER_PREFIX, record } from "../run/models.js";
import { getIn, graphOf, setIn, type Draft } from "./draft.js";

/**
 * A lineup read step by step: which model does each step, at which effort, in the vendor's own word ("Opus 5.5 ·
 * xhigh"), and which steps can be switched off. The steps' names are the design language's ("find issues · merge
 * duplicates · check each issue · write the plan · review the plan"). A new optional step is one entry in `STEPS`.
 */
type Stage = Parameters<typeof effortFor>[2];
const LEVEL_IN_ID = /-(low|medium|high|max)$/u;

/** A profile's model and effort at a stage. A model whose ID carries its effort (Gemini through Antigravity) shows it once. */
export function modelAt(draft: Draft, alias: unknown, stage: Stage): string {
  if (typeof alias !== "string") return "none chosen";
  const modelId = String(record(record(draft["models"])[alias])["modelId"] ?? alias);
  if (modelId.startsWith(PLACEHOLDER_PREFIX)) return "model not chosen yet";
  const level = LEVEL_IN_ID.exec(modelId)?.[1];
  return level !== undefined && modelId.startsWith("gemini-") ? `${modelName(modelId.replace(LEVEL_IN_ID, ""))} · ${level}` : `${modelName(modelId)} · ${effortFor(draft, alias, stage)}`;
}

const roles = (draft: Draft) => record(getIn(draft, ["workflow", "modelExecution", "roles"]));
const finders = (draft: Draft) => Object.keys(record(draft["models"])).filter((alias) => alias.startsWith("auditor-")).sort();
const modelBacked = (draft: Draft) => draft["mode"] === "audit" && finders(draft).length > 0 && getIn(draft, ["workflow", "modelExecution"]) !== undefined;

export interface Step {
  readonly id: string;
  readonly name: string;
  /** What the step does, in one line. */
  readonly explain: string;
  /** Absent for a step every run has. */
  readonly toggle?: { readonly on: (draft: Draft) => boolean; readonly set: (draft: Draft, on: boolean) => Draft; /** Why it is recommended off, where the runs showed its value is weak. */ readonly recommendOff?: string };
  /** Whether the step applies to this lineup at all. */
  readonly applies?: (draft: Draft) => boolean;
  /** Who does it, as "model · effort" lines. */
  readonly models: (draft: Draft) => readonly string[];
}

const MERGE_PAIRS = ["workflow", "modelExecution", "maximumClusteringPairs"] as const;

export const STEPS: readonly Step[] = Object.freeze([
  { id: "find", name: "Find issues", explain: "Each finder reads the whole project part by part, on its own, and reports the issues it sees and where they are.",
    models: (draft: Draft) => finders(draft).map((alias) => modelAt(draft, alias, "discovery")) },
  { id: "merge", name: "Merge duplicates", explain: "A model decides whether two reports are one issue, so each issue is checked and planned once. Off, only reports matched without a model are merged, and each duplicate left is checked on its own.",
    toggle: { on: (draft: Draft) => getIn(draft, MERGE_PAIRS) !== 0, set: (draft: Draft, on: boolean) => setIn(draft, MERGE_PAIRS, on ? undefined : 0) },
    models: (draft: Draft) => [modelAt(draft, roles(draft)["merger"] ?? roles(draft)["verifier"], "clustering")] },
  { id: "review", name: "Review round", explain: "Each finder reads the others' issues and says whether it agrees; issues they still disagree on are marked disputed.",
    toggle: { on: (draft: Draft) => Number(draft["maxConsensusRounds"] ?? 0) > 0, set: (draft: Draft, on: boolean) => setIn(draft, ["maxConsensusRounds"], on ? 1 : 0),
      recommendOff: "In two test runs it took about 40% of the tokens and added one or two issues." },
    applies: (draft: Draft) => finders(draft).length > 1,
    models: (draft: Draft) => finders(draft).map((alias) => modelAt(draft, alias, "peerReview")) },
  { id: "check", name: "Check each issue", explain: "A model reads the code again for each issue the plan covers, and confirms or rejects it.",
    models: (draft: Draft) => { const role = roles(draft); const medium = role["mediumVerifier"];
      return medium === undefined || medium === role["verifier"] ? [modelAt(draft, role["verifier"], "verification")] : [`critical and high ${modelAt(draft, role["verifier"], "verification")}`, `medium ${modelAt(draft, medium, "verification")}`]; } },
  { id: "second-opinion", name: "Second opinion", explain: "Before a critical or high issue is rejected, a model of another vendor is asked; if the two disagree, the issue stays unsettled.",
    toggle: { on: (draft: Draft) => getIn(draft, ["verification", "secondOpinion"]) === "severe_rejections", set: (draft: Draft, on: boolean) => setIn(draft, ["verification", "secondOpinion"], on ? "severe_rejections" : undefined) },
    models: (draft: Draft) => [modelAt(draft, roles(draft)["secondOpinion"] ?? roles(draft)["critic"], "secondOpinion")] },
  { id: "plan", name: "Write the plan", explain: "Turns the confirmed issues into tasks, each with a prompt a coding agent can carry out.",
    models: (draft: Draft) => [modelAt(draft, roles(draft)["planner"], "planner")] },
  { id: "critic", name: "Review the plan", explain: "A model of the other vendor reads the plan, each blocking point it raises is checked, and the plan is revised once.",
    toggle: { on: (draft: Draft) => getIn(draft, ["workflow", "critic"]) === true, set: (draft: Draft, on: boolean) => setIn(draft, ["workflow", "critic"], on),
      recommendOff: "On our runs its points were precise (18 of 20 real on nextra), but it caught 1 of the 21 plan errors met when the plan was carried out, its revision added errors, and it took 9 to 17% of a run's tokens." },
    applies: (draft: Draft) => graphOf(draft) === null,
    models: (draft: Draft) => [modelAt(draft, roles(draft)["critic"], "critic"), `its points checked by ${modelAt(draft, roles(draft)["critiqueChecker"] ?? roles(draft)["planner"], "critiqueCheck")}`] },
]);

export interface StepState { readonly step: Step; /** Null for a step every run has. */ readonly on: boolean | null; readonly models: readonly string[] }

/** The steps that apply to a model-backed audit, each with its switch's position and who does it. */
export function stepsOf(draft: Draft): readonly StepState[] {
  if (!modelBacked(draft)) return [];
  return STEPS.filter(({ applies }) => applies === undefined || applies(draft)).map((step) => ({ step, on: step.toggle === undefined ? null : step.toggle.on(draft), models: step.models(draft) }));
}

/** A lineup card's rows: the steps this lineup runs, with the second opinion read as part of checking. */
export function lineupRows(draft: Draft): readonly { readonly step: string; readonly models: readonly string[] }[] {
  const steps = stepsOf(draft);
  const opinion = steps.find(({ step }) => step.id === "second-opinion");
  return steps.filter(({ step, on }) => on !== false && step.id !== "second-opinion").map(({ step, models }) => ({ step: step.name,
    models: step.id === "check" && opinion?.on === true ? [...models, ...opinion.models.map((model) => `second opinion ${model}`)] : models }));
}
