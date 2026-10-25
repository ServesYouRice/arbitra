import { describe, expect, it } from "vitest";
import { customProblem, effortChoices, optionName, seatOptions, withCustomModel, withSeatEffort, withSeatModel, withSeatOption, withThirdFinder } from "../src/pages/new-run/assign.js";
import { isDepthLineup, withDepth } from "../src/pages/new-run/depth.js";
import { getIn, type Draft } from "../src/pages/new-run/draft.js";
import { lineupRows, modelAt } from "../src/pages/new-run/lineup.js";
import { routeOf, withRoute } from "../src/pages/new-run/routes.js";
import { TEMPLATES } from "../src/pages/new-run/templates.js";

const template = (id: string): Draft => { const found = TEMPLATES.find((item) => item.id === id); if (found === undefined) throw new Error(`no template ${id}`); return found.config; };
const rows = (draft: Draft) => lineupRows(draft).map(({ step, models }) => [step, ...models]);
const roles = (draft: Draft) => getIn(draft, ["workflow", "modelExecution", "roles"]) as Record<string, string>;
const modelOf = (draft: Draft, alias: string) => `${String(getIn(draft, ["models", alias, "transport"]))} ${String(getIn(draft, ["models", alias, "modelId"]))}`;
// What this computer's Antigravity offers (October 25, 2026), with Argon added as a newer account would list it.
const OFFERED = { "antigravity-cli": [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { id: "gemini-4-argon", name: "Gemini 4 Argon" }, { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6" }] };

describe("how a lineup reaches its models", () => {
  it("reaches the same models and efforts through API keys as through the CLIs, and back", () => {
    const cli = template("subscription-audit");
    const api = withRoute(cli, "api");
    expect([routeOf(cli), routeOf(api), isDepthLineup(api)]).toEqual(["cli", "api", true]);
    expect([modelOf(api, "auditor-a"), modelOf(api, "auditor-b")]).toEqual(["anthropic-messages claude-opus-5-5", "openai-responses gpt-6.1-sol"]);
    expect((getIn(api, ["workflow", "modelExecution", "endpoints"]) as { apiKeyEnvVar?: string }[]).map(({ apiKeyEnvVar }) => apiKeyEnvVar)).toEqual(["ARBITRA_ANTHROPIC_API_KEY", "ARBITRA_OPENAI_API_KEY"]);
    expect(rows(api)).toEqual(rows(cli));
    expect(withRoute(api, "cli")).toEqual(cli);
    // A depth writes the same models whichever way they are reached.
    expect(rows(withDepth(api, "cheap"))).toEqual(rows(withDepth(cli, "cheap")));
    expect(modelOf(withDepth(api, "cheap"), "auditor-a")).toBe("anthropic-messages claude-sonnet-5-5");
  });

  it("adds the third finder through the lineup's own route, and says when a model has no API equivalent", () => {
    const api = withThirdFinder(withRoute(template("subscription-audit"), "api"), "default", {});
    expect(modelOf(api, "auditor-c")).toBe("gemini-native gemini-3.8-flash");
    const argon = withThirdFinder(template("subscription-audit"), { transport: "antigravity-cli", modelId: "gemini-4-argon" }, OFFERED);
    expect(modelOf(argon, "auditor-c")).toBe("antigravity-cli gemini-4-argon");
    expect(modelAt(withRoute(argon, "api"), "auditor-c", "discovery")).toBe("Gemini 4 Argon · not offered through an API key");
  });
});

describe("a step's model and effort, changed in place", () => {
  it("moves one step to another model without moving the finder that held it, and keeps its effort", () => {
    const deep = template("subscription-audit");
    const sonnetPlans = withSeatModel(deep, { kind: "role", role: "planner" }, "claude-code-cli", "claude-sonnet-5-5", {});
    expect([roles(sonnetPlans)["planner"], modelOf(sonnetPlans, roles(sonnetPlans)["planner"] ?? ""), modelOf(sonnetPlans, "auditor-a")]).toEqual(["planner", "claude-code-cli claude-sonnet-5-5", "claude-code-cli claude-opus-5-5"]);
    expect(rows(sonnetPlans).find(([step]) => step === "Write the plan")).toEqual(["Write the plan", "Sonnet 5.5 · high"]);
    // A finder takes another model; the steps it also did keep Opus.
    const sonnetFinds = withSeatModel(deep, { kind: "finder", alias: "auditor-a" }, "claude-code-cli", "claude-sonnet-5-5", {});
    expect(rows(sonnetFinds)).toEqual([["Find issues", "Sonnet 5.5 · xhigh", "GPT-6.1 Sol · xhigh"], ["Merge duplicates", "Opus 5.5 · low"],
      ["Check each issue", "Opus 5.5 · high", "second opinion GPT-6.1 Sol · high"], ["Write the plan", "Opus 5.5 · high"]]);
    // Choosing the depth again writes it afresh, and the profiles a step had of its own go.
    expect(withDepth(sonnetPlans, "deep")).toEqual(deep);
  });

  it("sets a step's effort in its model's words, the plan's revision with it", () => {
    const deep = template("subscription-audit");
    expect(effortChoices(deep, "auditor-a", {})).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const lighter = withSeatEffort(deep, { kind: "role", role: "planner" }, "medium", {});
    expect([getIn(lighter, ["workflow", "modelExecution", "stageEffort", "planner", "auditor-a"]), getIn(lighter, ["workflow", "modelExecution", "stageEffort", "revision", "auditor-a"])]).toEqual(["medium", "medium"]);
    expect(rows(lighter).find(([step]) => step === "Write the plan")).toEqual(["Write the plan", "Opus 5.5 · medium"]);
    // Gemini through Antigravity names its thinking level in its model ID: the effort picks the ID.
    const three = withThirdFinder(deep, "default", {});
    expect(effortChoices(three, "auditor-c", {})).toEqual(["high", "medium", "low"]);
    expect(modelOf(withSeatEffort(three, { kind: "finder", alias: "auditor-c" }, "medium", {}), "auditor-c")).toBe("antigravity-cli gemini-3.8-flash-medium");
  });

  it("offers Gemini only for optional work, first there, with Argon when Antigravity offers it", () => {
    const three = withThirdFinder(template("subscription-audit"), "default", OFFERED);
    const names = (seat: Parameters<typeof seatOptions>[1]) => seatOptions(three, seat, OFFERED).map(({ key, models }) => `${key.slice(2)}: ${models.map(({ modelId }) => modelId).join(", ")}`);
    expect(names({ kind: "role", role: "planner" })).toEqual(["claude-code-cli: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-sonnet-5, claude-haiku-4-5-20251001", "codex-cli: gpt-6.1-sol, gpt-6-luna, gpt-5.6-luna"]);
    expect(names({ kind: "finder", alias: "auditor-a" })).toEqual(["claude-code-cli: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-sonnet-5, claude-haiku-4-5-20251001"]);
    expect(names({ kind: "finder", alias: "auditor-c" })[0]).toBe("antigravity-cli: gemini-4-argon, gemini-3.8-flash-high");
    expect(names({ kind: "finder", alias: "auditor-c" })).toHaveLength(3);
  });

  it("takes a model the person names on an OpenAI-compatible endpoint, Kimi through Moonshot for one, and keeps the depths", () => {
    const moonshot = { preset: "moonshot", baseUrl: "https://api.moonshot.ai/v1", modelId: "kimi-3.1", keyVar: "ARBITRA_MOONSHOT_API_KEY" };
    expect([customProblem({ ...moonshot, modelId: " " }), customProblem({ ...moonshot, baseUrl: "https://api.moonshot.ai/v1?key=abc" }), customProblem({ ...moonshot, keyVar: "moonshot key" }), customProblem(moonshot)])
      .toEqual(["Name the model as the endpoint lists it.", "The base URL must be an http or https address, with no key, query or fragment in it.", "The key variable is an environment variable name, in capitals, such as ARBITRA_MOONSHOT_API_KEY.", null]);
    const kimi = withCustomModel(withThirdFinder(template("subscription-audit"), "default", {}), { kind: "finder", alias: "auditor-c" }, moonshot, {});
    expect(modelOf(kimi, "auditor-c")).toBe("openai-chat kimi-3.1");
    expect(getIn(kimi, ["models", "auditor-c"])).toMatchObject({ provider: "moonshot", family: "kimi", independenceGroup: "moonshot" });
    // Antigravity, no longer used, goes with its rate policy; the endpoint the model was named on stays.
    expect((getIn(kimi, ["workflow", "modelExecution", "endpoints"]) as { id: string }[]).map(({ id }) => id)).toEqual(["claude-code", "codex", "moonshot"]);
    expect(Object.keys(getIn(kimi, ["workflow", "modelExecution", "rateLimits"]) as object)).toEqual(["anthropic", "openai", "moonshot"]);
    expect([routeOf(kimi), isDepthLineup(kimi), modelOf(withDepth(kimi, "cheap"), "auditor-c")]).toEqual(["cli", true, "openai-chat kimi-3.1"]);
    // Named once, it is offered to the other steps, not measured.
    const kimiGroup = seatOptions(kimi, { kind: "role", role: "critic" }, {}).find(({ key }) => key === "e:moonshot");
    expect(kimiGroup?.models.map((model) => optionName(kimiGroup.transport, model))).toEqual(["kimi-3.1 (not measured)"]);
    expect(roles(withSeatOption(kimi, { kind: "role", role: "critic" }, "e:moonshot|kimi-3.1", {}))["critic"]).toBe("auditor-c");
    expect(seatOptions(kimi, { kind: "finder", alias: "auditor-a" }, {}).map(({ key }) => key)).toEqual(["t:claude-code-cli"]);
  });
});
