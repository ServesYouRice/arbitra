import { describe, expect, it } from "vitest";
import { dollars, routeSwitchWords } from "../src/app/words.js";
import { withDepth } from "../src/pages/new-run/depth.js";
import { getIn, type Draft } from "../src/pages/new-run/draft.js";
import { fallbackChoices, withCostCap, withFallback, withSyncedFallbacks } from "../src/pages/new-run/fallback.js";
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

  it("says a switch, a pause at the cap and a return in one line each", () => {
    const base = { model: "Opus 5.5", effort: "xhigh", toModel: "Opus 5.5", at: null, spentUsd: 182.4, capUsd: null, resetsAt: null };
    expect(routeSwitchWords({ ...base, from: "API key", to: "Claude Code", reason: "credit_out" })).toBe("Switched Opus 5.5 · xhigh from API key to Claude Code, credit out ($182 spent).");
    expect(routeSwitchWords({ ...base, from: "API key", to: null, reason: "cost_cap", capUsd: 150, spentUsd: 150.2 })).toBe("Opus 5.5 · xhigh through API key stopped: its $150 cap reached ($150 spent). No fallback is set, so the run paused.");
    expect(routeSwitchWords({ ...base, from: "API key", to: "Claude Code", reason: "reset", spentUsd: null })).toBe("Went back to Opus 5.5 · xhigh through Claude Code: its limit has reset.");
    expect([dollars(182.4), dollars(3.4), dollars(0.001)]).toEqual(["$182", "$3.40", "under $0.01"]);
  });
});
