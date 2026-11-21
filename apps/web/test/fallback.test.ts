import { describe, expect, it } from "vitest";
import { formatTime } from "../src/app/format.js";
import { dollars, optionalStepWords, routeSwitchWords } from "../src/app/words.js";
import { withDepth } from "../src/pages/new-run/depth.js";
import { getIn, type Draft } from "../src/pages/new-run/draft.js";
import { withThirdFinder } from "../src/pages/new-run/assign.js";
import { fallbackChoices, withCostCap, withFallback, withSyncedFallbacks, withUsageLimitFallbacks } from "../src/pages/new-run/fallback.js";
import { withStrongestOffered } from "../src/pages/new-run/model-catalog.js";
import { routeOf, withRoute } from "../src/pages/new-run/routes.js";
import { TEMPLATES } from "../src/pages/new-run/templates.js";
import { record } from "../src/pages/run/models.js";

const template = (id: string): Draft => { const found = TEMPLATES.find((item) => item.id === id); if (found === undefined) throw new Error(`no template ${id}`); return found.config; };
const execution = (draft: Draft) => record(getIn(draft, ["workflow", "modelExecution"]));
const model = (draft: Draft, alias: string) => record(record(draft["models"])[alias]);

// Observed live (memoria, November 10–11, 2026): Opus through an API key spent its $200 credit before the plan, and the
// plan went on through Claude Code only by a resume made by hand.
describe("when a model runs out", () => {
  it("gives a model the same model by the other route as its fallback, and keeps the lineup's route and depth cards", () => {
    const api = withRoute(template("subscription-audit"), "api");
    expect(routeOf(api)).toBe("api");
    const choices = fallbackChoices(api);
    expect(choices.map(({ alias, route, other, cappable }) => ({ alias, route, other, cappable }))).toEqual(expect.arrayContaining([
      { alias: "auditor-a", route: "api", other: "claude-code-cli", cappable: true }, { alias: "auditor-b", route: "api", other: "codex-cli", cappable: false }]));
    const withOne = withCostCap(withFallback(api, "auditor-a", true), "auditor-a", 150);
    expect(execution(withOne)["fallbacks"]).toEqual({ "auditor-a": "fallback-auditor-a" });
    expect(execution(withOne)["maximumCostUsd"]).toEqual({ "auditor-a": 150 });
    expect(model(withOne, "fallback-auditor-a")).toMatchObject({ transport: "claude-code-cli", modelId: model(api, "auditor-a")["modelId"] });
    const bound = String(record(execution(withOne)["modelEndpoints"])["fallback-auditor-a"]);
    expect((execution(withOne)["endpoints"] as readonly { id: string; transport: string }[]).find(({ id }) => id === bound)?.transport).toBe("claude-code-cli");
    // The fallback takes the other route by design: the lineup still takes the API, and is not a mixed one.
    expect(routeOf(withOne)).toBe("api");
    expect(fallbackChoices(withOne).find(({ alias }) => alias === "auditor-a")).toMatchObject({ fallback: "fallback-auditor-a", capUsd: 150 });
    expect(fallbackChoices(withOne).some(({ alias }) => alias === "fallback-auditor-a")).toBe(false);
  });

  it("removes the fallback, its profile and its endpoint when the run is to pause instead", () => {
    const api = withRoute(template("subscription-audit"), "api");
    const off = withFallback(withFallback(api, "auditor-a", true), "auditor-a", false);
    expect(execution(off)["fallbacks"]).toBeUndefined();
    expect(model(off, "fallback-auditor-a")).toEqual({});
    expect(execution(off)["endpoints"]).toEqual(execution(api)["endpoints"]);
    expect(execution(withCostCap(withCostCap(api, "auditor-a", 10), "auditor-a", null))["maximumCostUsd"]).toBeUndefined();
  });

  it("makes a fallback follow the depth chosen for its model, and drops fallbacks and caps when the route changes", () => {
    const api = withCostCap(withFallback(withRoute(template("subscription-audit"), "api"), "auditor-a", true), "auditor-a", 150);
    const cheap = withSyncedFallbacks(withDepth(api, "cheap"));
    expect(model(cheap, "fallback-auditor-a")["modelId"]).toBe(model(cheap, "auditor-a")["modelId"]);
    expect(model(cheap, "fallback-auditor-a")["transport"]).toBe("claude-code-cli");
    expect(withSyncedFallbacks(cheap)).toBe(cheap);
    const cli = withRoute(api, "cli");
    expect(routeOf(cli)).toBe("cli");
    expect(execution(cli)["fallbacks"]).toBeUndefined();
    expect(execution(cli)["maximumCostUsd"]).toBeUndefined();
    expect(model(cli, "fallback-auditor-a")).toEqual({});
    // Through the CLIs, the fallback is the API key, and the subscription takes no cap.
    const back = withFallback(cli, "auditor-a", true);
    expect(model(back, "fallback-auditor-a")["transport"]).toBe("anthropic-messages");
    expect(fallbackChoices(back).find(({ alias }) => alias === "auditor-a")).toMatchObject({ route: "cli", cappable: false, capUsd: null });
  });

  // Observed live (November 21, 2026, agy 1.5.14): Gemini 4 Argon High met a weekly limit of its own after 34 minutes and
  // the finder was left out, while the other Gemini models, which share theirs, had all of it.
  it("gives a Gemini finder through Antigravity the Gemini model of the other usage limit as its fallback, on the same endpoint", () => {
    const offered = { "antigravity-cli": [{ id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" }, { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" }, { id: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" }, { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }] };
    const base = template("subscription-audit-gemini");
    const neon = withUsageLimitFallbacks(withStrongestOffered(base, offered), offered);
    expect([model(neon, "auditor-c")["modelId"], execution(neon)["fallbacks"]]).toEqual(["gemini-4-neon-high", { "auditor-c": "fallback-auditor-c" }]);
    expect(model(neon, "fallback-auditor-c")).toMatchObject({ transport: "antigravity-cli", modelId: "gemini-4-argon-high", family: "gemini" });
    const bindings = record(execution(neon)["modelEndpoints"]);
    expect(bindings["fallback-auditor-c"]).toBe(bindings["auditor-c"]);
    expect(execution(neon)["endpoints"]).toEqual(execution(base)["endpoints"]);
    // Still a lineup through the CLIs, with its depth cards; Neon has no API equivalent, so the same model is the only way on.
    expect(routeOf(neon)).toBe("cli");
    expect(fallbackChoices(neon, offered).find(({ alias }) => alias === "auditor-c")).toMatchObject({ other: null, sameRoute: { modelId: "gemini-4-argon-high", model: "Gemini 4 Argon high" },
      fallback: "fallback-auditor-c", kind: "model", optional: true, cappable: false });
    expect(fallbackChoices(neon, offered).find(({ alias }) => alias === "auditor-a")).toMatchObject({ sameRoute: null, kind: null, optional: false });
    // Added once: a lineup that has it, or one whose person took it away, is not given it again.
    expect(withUsageLimitFallbacks(neon, offered)).toBe(neon);
    const paused = withFallback(neon, "auditor-c", false, offered);
    expect([execution(paused)["fallbacks"], model(paused, "fallback-auditor-c"), execution(paused)["endpoints"]]).toEqual([undefined, {}, execution(base)["endpoints"]]);
    expect(withFallback(paused, "auditor-c", "model", offered)).toEqual(neon);
    // Kept while the CLI's list is not read yet, and moved to Neon when the finder takes Argon.
    expect(withSyncedFallbacks(neon)).toBe(neon);
    expect(withSyncedFallbacks(neon, offered)).toBe(neon);
    const argon = withSyncedFallbacks(withThirdFinder(neon, { transport: "antigravity-cli", modelId: "gemini-4-argon-high" }, offered), offered);
    expect([model(argon, "auditor-c")["modelId"], model(argon, "fallback-auditor-c")["modelId"]]).toEqual(["gemini-4-argon-high", "gemini-4-neon-high"]);
    // A CLI that lists one usage limit's models only offers no other to go on with.
    const flashOnly = { "antigravity-cli": [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }] };
    expect(withUsageLimitFallbacks(base, flashOnly)).toBe(base);
    expect(fallbackChoices(base, flashOnly).find(({ alias }) => alias === "auditor-c")).toMatchObject({ other: "gemini-native", sameRoute: null });
    expect(execution(withSyncedFallbacks(neon, flashOnly))["fallbacks"]).toBeUndefined();
  });

  it("starts a third finder through Antigravity with the other usage limit's model, and takes both away with it", () => {
    const offered = { "antigravity-cli": [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { id: "gemini-4-argon", name: "Gemini 4 Argon" }] };
    const two = template("subscription-audit");
    const three = withThirdFinder(two, "default", offered);
    expect([model(three, "auditor-c")["modelId"], model(three, "fallback-auditor-c")["modelId"], execution(three)["fallbacks"]]).toEqual(["gemini-3.8-flash-high", "gemini-4-argon", { "auditor-c": "fallback-auditor-c" }]);
    // A finder already there keeps what its person chose.
    const kept = withThirdFinder(withFallback(three, "auditor-c", false, offered), { transport: "antigravity-cli", modelId: "gemini-4-argon" }, offered);
    expect(execution(kept)["fallbacks"]).toBeUndefined();
    const removed = withThirdFinder(three, null, offered);
    expect([model(removed, "auditor-c"), model(removed, "fallback-auditor-c"), execution(removed)["fallbacks"], execution(removed)["endpoints"]]).toEqual([{}, {}, undefined, execution(two)["endpoints"]]);
  });

  it("says a switch, a pause at the cap and a return in one line each", () => {
    const base = { model: "Opus 5.5", effort: "xhigh", toModel: "Opus 5.5", at: null, spentUsd: 182.4, capUsd: null, resetsAt: null };
    expect(routeSwitchWords({ ...base, from: "API key", to: "Claude Code", reason: "credit_out" })).toBe("Switched Opus 5.5 · xhigh from API key to Claude Code, credit out ($182 spent).");
    expect(routeSwitchWords({ ...base, from: "API key", to: null, reason: "cost_cap", capUsd: 150, spentUsd: 150.2 })).toBe("Opus 5.5 · xhigh through API key stopped: its $150 cap reached ($150 spent). No fallback is set, so the run paused.");
    expect(routeSwitchWords({ ...base, from: "API key", to: "Claude Code", reason: "reset", spentUsd: null })).toBe("Went back to Opus 5.5 · xhigh through Claude Code: its limit has reset.");
    // A switch to another model by the same route says the route once, and a model whose ID carries its thinking no effort.
    expect(routeSwitchWords({ model: "Gemini 4 Argon high", effort: "high", from: "Antigravity", to: "Antigravity", toModel: "Gemini 4 Neon high", at: null, reason: "usage_limit",
      spentUsd: null, capUsd: null, resetsAt: null })).toBe("Switched Gemini 4 Argon high through Antigravity to Gemini 4 Neon high, usage limit reached.");
    expect([dollars(182.4), dollars(3.4), dollars(0.001)]).toEqual(["$182", "$3.40", "under $0.01"]);
  });

  it("says an optional step that went to another model, or on without one, in one line with what that leaves", () => {
    // Observed live (November 11, 2026): one second opinion waited 3 h 04 on Codex's window, and nothing said why.
    const base = { model: "GPT-6.1 Sol", at: "2026-11-11T09:13:00.000Z", resetsAt: "2026-11-11T12:17:00.000Z" };
    const when = `at ${formatTime(base.at)}: usage limit reached, until ${formatTime(base.resetsAt)}.`;
    expect(optionalStepWords({ ...base, step: "secondOpinion", toModel: "Opus 5.5" })).toBe(`The second opinion went from GPT-6.1 Sol to Opus 5.5 ${when}`);
    expect(optionalStepWords({ ...base, step: "secondOpinion", toModel: null })).toBe(`The second opinion on GPT-6.1 Sol was left out ${when} The severe issues it would have checked stay open, not rejected.`);
    expect(optionalStepWords({ ...base, step: "critic", toModel: null, resetsAt: null, at: null })).toBe("The plan review on GPT-6.1 Sol was left out: usage limit reached. The plan went on unreviewed.");
    expect(optionalStepWords({ ...base, step: "finder", toModel: null, at: null })).toMatch(/^The finder on GPT-6\.1 Sol was left out: .* Its answered parts stand, and the other finders went on\.$/u);
    expect(optionalStepWords({ ...base, step: "variantSearch", toModel: null, at: null })).toMatch(/^The variant search on GPT-6\.1 Sol was left out: .* The issues it had left to search stand without it\.$/u);
  });
});
