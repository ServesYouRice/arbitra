import { describe, expect, it } from "vitest";
import { withDepth, withFinders } from "../src/pages/new-run/depth.js";
import { getIn, setIn, type Draft } from "../src/pages/new-run/draft.js";
import { lineupRows, modelAt, stepsOf, STEPS } from "../src/pages/new-run/lineup.js";
import { SCRIPTED_AUDIT, TEMPLATES } from "../src/pages/new-run/templates.js";

const template = (id: string): Draft => { const found = TEMPLATES.find((item) => item.id === id); if (found === undefined) throw new Error(`no template ${id}`); return found.config; };
const rows = (draft: Draft) => lineupRows(draft).map(({ step, models }) => [step, ...models]);

describe("a lineup, step by step, as model and effort", () => {
  it("names each model as its vendor does, with the effort in the CLI's own word, Gemini's taken from its model ID", () => {
    const three = withFinders(template("subscription-audit"), 3);
    expect([modelAt(three, "auditor-a", "discovery"), modelAt(three, "auditor-b", "discovery"), modelAt(three, "auditor-c", "discovery")]).toEqual(["Opus 5.5 · xhigh", "GPT-6.1 Sol · xhigh", "Gemini 3.8 Flash · high"]);
    // A template's placeholder is a model still to choose, not a model's name.
    expect(modelAt(template("audit-mixed-providers"), "auditor-a", "discovery")).toBe("model not chosen yet");
  });

  it("reads the approved table at each depth: find, merge, check with its second opinion, plan", () => {
    const two = template("subscription-audit");
    expect(rows(two)).toEqual([
      ["Find issues", "Opus 5.5 · xhigh", "GPT-6.1 Sol · xhigh"], ["Merge duplicates", "Opus 5.5 · low"],
      ["Check each issue", "Opus 5.5 · high", "second opinion GPT-6.1 Sol · high"], ["Write the plan", "Opus 5.5 · high"]]);
    expect(rows(withDepth(two, "balanced"))).toEqual([
      ["Find issues", "Opus 5.5 · medium", "GPT-6.1 Sol · medium"], ["Merge duplicates", "Opus 5.5 · low"],
      ["Check each issue", "critical and high Opus 5.5 · high", "medium Sonnet 5.5 · high", "second opinion GPT-6.1 Sol · medium"], ["Write the plan", "Opus 5.5 · medium"]]);
    expect(rows(withDepth(two, "cheap"))).toEqual([
      ["Find issues", "Sonnet 5.5 · high", "GPT-6 Luna · max"], ["Merge duplicates", "Sonnet 5.5 · medium"],
      ["Check each issue", "critical and high Opus 5.5 · high", "medium Sonnet 5.5 · high", "second opinion GPT-6.1 Sol · medium"], ["Write the plan", "Sonnet 5.5 · high"]]);
    // A step switched on joins the card; one switched off leaves it.
    const reviewed = setIn(setIn(setIn(two, ["workflow", "critic"], true), ["maxConsensusRounds"], 1), ["verification", "secondOpinion"], undefined);
    expect(rows(reviewed)).toEqual([
      ["Find issues", "Opus 5.5 · xhigh", "GPT-6.1 Sol · xhigh"], ["Merge duplicates", "Opus 5.5 · low"], ["Review round", "Opus 5.5 · high", "GPT-6.1 Sol · high"],
      ["Check each issue", "Opus 5.5 · high"], ["Write the plan", "Opus 5.5 · high"], ["Review the plan", "GPT-6.1 Sol · high", "its points checked by Opus 5.5 · high"]]);
  });

  it("lists every step with its switch, the plan review recommended off and why, and adds a step as one entry", () => {
    const two = template("subscription-audit");
    expect(stepsOf(two).map(({ step, on }) => [step.name, on])).toEqual([["Find issues", null], ["Merge duplicates", true], ["Review round", false], ["Check each issue", null],
      ["Second opinion", true], ["Search for variants", false], ["Write the plan", null], ["Review the plan", false]]);
    const variants = STEPS.find(({ id }) => id === "variant-search");
    if (variants?.toggle === undefined) throw new Error("the variant search has no switch");
    const searching = variants.toggle.set(two, true);
    expect([variants.toggle.on(searching), stepsOf(searching).find(({ step }) => step.id === "variant-search")?.models]).toEqual([true, ["Sonnet 5.5 · high"]]);
    const critic = STEPS.find(({ id }) => id === "critic");
    expect(critic?.toggle?.recommendOff).toMatch(/caught 1 of the 21 plan errors/u);
    if (critic?.toggle === undefined) throw new Error("the plan review has no switch");
    expect(getIn(critic.toggle.set(two, true), ["workflow", "critic"])).toBe(true);
    const merge = STEPS.find(({ id }) => id === "merge");
    if (merge?.toggle === undefined) throw new Error("merging has no switch");
    const unmerged = merge.toggle.set(two, false);
    expect([getIn(unmerged, ["workflow", "modelExecution", "maximumClusteringPairs"]), merge.toggle.on(unmerged), getIn(merge.toggle.set(unmerged, true), ["workflow", "modelExecution", "maximumClusteringPairs"])]).toEqual([0, false, undefined]);
    // A saved graph decides its own critic, and one finder has nobody to review with.
    expect(stepsOf(setIn(setIn(two, ["workflow", "preset"], undefined), ["workflow", "graph"], { id: "g", version: "v" })).map(({ step }) => step.id)).not.toContain("critic");
    expect(stepsOf(setIn(two, ["models", "auditor-b"], undefined)).map(({ step }) => step.id)).not.toContain("review");
    // Scripted detectors have no models to name and no switches that apply.
    expect(lineupRows(SCRIPTED_AUDIT)).toEqual([]);
  });
});
