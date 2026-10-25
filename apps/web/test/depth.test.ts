import { describe, expect, it } from "vitest";
import { DEPTHS, findersOf, withDepth, withFinders, type Depth, type FinderCount } from "../src/pages/new-run/depth.js";
import { getIn, type Draft } from "../src/pages/new-run/draft.js";
import { TEMPLATES } from "../src/pages/new-run/templates.js";
import { effortFor, modelName, record } from "../src/pages/run/models.js";

const template = (id: string): Draft => { const found = TEMPLATES.find((item) => item.id === id); if (found === undefined) throw new Error(`no template ${id}`); return found.config; };
const DEPTH_NAMES = Object.keys(DEPTHS) as Depth[];
const roles = (config: Draft) => record(getIn(config, ["workflow", "modelExecution", "roles"]));

/** What a configuration runs at each step, as "model · effort" in the vendor's own word. */
function lineup(config: Draft): Record<string, unknown> {
  const models = record(config["models"]); const role = roles(config);
  type Stage = Parameters<typeof effortFor>[2];
  const at = (alias: unknown, stage: Stage) => `${modelName(String(record(models[String(alias)])["modelId"]))} · ${effortFor(config, String(alias), stage)}`;
  return {
    find: Object.keys(models).filter((alias) => alias.startsWith("auditor-")).sort().map((alias) => at(alias, "discovery")),
    merge: at(role["merger"] ?? role["verifier"], "clustering"),
    "check critical and high": at(role["verifier"], "verification"),
    "check medium": at(role["mediumVerifier"] ?? role["verifier"], "verification"),
    "second opinion": at(role["secondOpinion"], "secondOpinion"),
    plan: at(role["planner"], "planner"),
    "review the plan": at(role["critic"], "critic"),
    "check the review": at(role["critiqueChecker"], "critiqueCheck"),
  };
}

describe("depth presets", () => {
  it("writes the owner's table of models and efforts, in each vendor's word, at every depth", () => {
    const two = template("subscription-audit");
    // October 25, 2026. Depths differ only in models and efforts; balanced checks like cheap (owner, the same day).
    expect(Object.fromEntries(DEPTH_NAMES.map((depth) => [depth, lineup(withDepth(two, depth))]))).toEqual({
      deep: { find: ["Opus 5.5 · xhigh", "GPT-6.1 Sol · xhigh"], merge: "Opus 5.5 · low", "check critical and high": "Opus 5.5 · high", "check medium": "Opus 5.5 · high",
        "second opinion": "GPT-6.1 Sol · high", plan: "Opus 5.5 · high", "review the plan": "GPT-6.1 Sol · high", "check the review": "Opus 5.5 · high" },
      balanced: { find: ["Opus 5.5 · medium", "GPT-6.1 Sol · medium"], merge: "Opus 5.5 · low", "check critical and high": "Opus 5.5 · high", "check medium": "Sonnet 5.5 · high",
        "second opinion": "GPT-6.1 Sol · medium", plan: "Opus 5.5 · medium", "review the plan": "GPT-6.1 Sol · medium", "check the review": "Opus 5.5 · medium" },
      cheap: { find: ["Sonnet 5.5 · high", "GPT-6 Luna · max"], merge: "Sonnet 5.5 · medium", "check critical and high": "Opus 5.5 · high", "check medium": "Sonnet 5.5 · high",
        "second opinion": "GPT-6.1 Sol · medium", plan: "Sonnet 5.5 · high", "review the plan": "GPT-6 Luna · high", "check the review": "Sonnet 5.5 · high" },
    });
    // The third finder is Gemini at high, whatever the depth.
    for (const depth of DEPTH_NAMES) expect((lineup(withFinders(withDepth(two, depth), 3))["find"] as string[])[2]).toBe("Gemini 3.8 Flash high · high");
  });

  it("makes today's subscription template exactly deep, two finders, critic off, and the Gemini template the same with a third finder", () => {
    const two = template("subscription-audit"); const three = template("subscription-audit-gemini");
    expect([two["auditDepth"], findersOf(two), getIn(two, ["workflow", "critic"])]).toEqual(["deep", 2, false]);
    expect(withFinders(withDepth(two, "deep"), 2)).toEqual(two);
    expect(withFinders(two, 3)).toEqual(three);
    expect(withFinders(three, 2)).toEqual(two);
    expect(withDepth(three, "deep")).toEqual(three);
  });

  it("removes what a lighter depth added when the depth goes back, and keeps the critic switch and finder count as they were", () => {
    const two = template("subscription-audit");
    for (const depth of ["cheap", "balanced"] as const) expect(withDepth(withDepth(two, depth), "deep")).toEqual(two);
    const reviewed = { ...two, workflow: { ...record(two["workflow"]), critic: true } };
    expect(getIn(withDepth(withFinders(reviewed, 3), "cheap"), ["workflow", "critic"])).toBe(true);
    expect(findersOf(withDepth(withFinders(two, 3), "cheap"))).toBe(3);
  });

  it("gives Gemini only the optional third finder, never checking, a second opinion, merging, planning or the critic", () => {
    // The owner, October 25, 2026: only work that is optional or usually not worth spending on goes to Gemini.
    for (const depth of DEPTH_NAMES) for (const count of [2, 3] as const) {
      const config = withFinders(withDepth(template("subscription-audit"), depth), count);
      const geminiProfiles = Object.entries(record(config["models"])).filter(([, profile]) => record(profile)["transport"] === "antigravity-cli").map(([alias]) => alias);
      expect(geminiProfiles, `${depth} ${count}`).toEqual(count === 3 ? ["auditor-c"] : []);
      expect(Object.values(roles(config)).filter((alias) => geminiProfiles.includes(String(alias))), `${depth} ${count}`).toEqual([]);
      const efforts = record(getIn(config, ["workflow", "modelExecution", "stageEffort"]));
      for (const [stage, value] of Object.entries(efforts)) if (typeof value === "object" && stage !== "discovery") expect(Object.keys(record(value))).not.toContain("auditor-c");
      if (count === 3) expect([getIn(config, ["models", "auditor-c", "modelId"]), effortFor(config, "auditor-c", "discovery")]).toEqual(["gemini-3.8-flash-high", "high"]);
    }
  });

  it("asks every profile for a level it supports at every step (the examples gate runs full preflight on each)", () => {
    for (const depth of DEPTH_NAMES) for (const count of [2, 3] as FinderCount[]) {
      const config = withFinders(withDepth(template("subscription-audit"), depth), count);
      const models = record(config["models"]);
      for (const [stage, value] of Object.entries(record(getIn(config, ["workflow", "modelExecution", "stageEffort"])))) {
        const levels = typeof value === "string" ? Object.keys(models).map((alias) => [alias, value] as const) : Object.entries(record(value));
        for (const [alias, level] of levels) {
          const effort = record(record(models[alias])["effort"]);
          const supported = (effort["supported"] as unknown[]).includes(level) || record(effort["collapse"])[String(level)] !== undefined;
          expect(supported, `${depth} ${count} ${stage} ${alias} ${String(level)}`).toBe(true);
        }
      }
    }
  });

  it("changes only the depth label of a configuration that is not Claude Code and Codex", () => {
    const api = template("audit-mixed-providers");
    expect(withDepth(api, "cheap")).toEqual({ ...api, auditDepth: "cheap" });
    expect(withFinders(api, 2)).toBe(api);
  });
});
