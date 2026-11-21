import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { ProviderUsageLimitError } from "@arbitra/providers/runtime.js";
import { limitedWords, OPTIONAL_STEPS_KIND, OptionalSteps, resetOf, secondOpinionStandIns } from "../src/optional-steps.js";
import { RunStore } from "../src/run-store.js";

/*
 * The owner's rule (November 2026): an optional step never holds the run on another vendor's usage window. Observed live
 * (November 11, 2026): one second opinion, on GPT-6.1 Sol through Codex, waited 3 h 04 on Codex's five-hour window while
 * the plan, on another login, could have run. The clock here is a fake one; no model is called.
 */

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const WAIT = 30 * 60_000;
const CODEX = "Provider openai reached its usage limit (QUOTA: CLI_USAGE_LIMIT_REACHED: the Codex subscription's usage allowance is exhausted until 2026-11-11T12:17:00.000Z); the run pauses with its completed work kept and goes on when resumed after the reset.";

async function store(): Promise<RunStore> {
  const directory = await mkdtemp(join(tmpdir(), "arbitra-optional-steps-")); directories.push(directory);
  return new RunStore(directory, "run-1");
}

/** A run of five profiles: Opus on Claude Code, Sol and Luna on one Codex login, GPT through an API key, and Gemini at two capabilities on Antigravity. */
async function lineup() {
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const template = example.models["auditor-a"];
  if (template === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const profile = (provider: string, modelId: string, capabilityTier: "fast" | "balanced" | "frontier", transport: string) => ({ ...template, provider, modelId, capabilityTier, transport, independenceGroup: provider });
  return runConfigSchema.parse({ ...example, models: {
    opus: profile("anthropic", "claude-opus-5-5", "frontier", "claude-code-cli"), sol: profile("openai", "gpt-6.1-sol", "frontier", "codex-cli"), luna: profile("openai", "gpt-6-luna", "frontier", "codex-cli"),
    "gpt-api": profile("openai", "gpt-6.1-sol", "frontier", "openai-responses"), gemini: profile("google", "gemini-3.8-flash-high", "frontier", "antigravity-cli"), "gemini-low": profile("google", "gemini-3.8-flash-low", "fast", "antigravity-cli"),
  }, workflow: { modelExecution: {
    endpoints: [{ id: "claude-code", providerId: "anthropic", transport: "claude-code-cli", endpoint: "cli://claude-code", auth: "subscription_login" },
      { id: "codex", providerId: "openai", transport: "codex-cli", endpoint: "cli://codex", auth: "subscription_login" },
      { id: "openai-api", providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.example/v1", apiKeyEnvVar: "FIXTURE_KEY" },
      { id: "antigravity", providerId: "google", transport: "antigravity-cli", endpoint: "cli://antigravity", auth: "subscription_login" }],
    modelEndpoints: { opus: "claude-code", sol: "codex", luna: "codex", "gpt-api": "openai-api", gemini: "antigravity", "gemini-low": "antigravity" },
    maximumOutputTokens: 10, maximumTokens: 1_000, maximumRetries: 0, timeoutMs: 1_000, rateLimits: Object.fromEntries(["anthropic", "openai", "google"].map((id) => [id, { rpm: 1, tpm: 1_000, maxConcurrent: 1 }])),
  } } });
}

describe("optional steps on a model out of its allowance", () => {
  it("does not ask a model again before its reset, but asks one whose reset is within the run's wait, and one with no reset after a resume", async () => {
    const run = await store();
    let now = Date.parse("2026-11-11T09:13:00.000Z");
    const steps = new OptionalSteps(run, WAIT, () => now);
    expect(await steps.limitedUntil("sol")).toBeUndefined();
    expect(await steps.limited("sol", new ProviderUsageLimitError(CODEX, 1, 3 * 3_600_000 + 4 * 60_000))).toBe("2026-11-11T12:17:00.000Z");
    expect(await steps.limitedUntil("sol")).toBe("2026-11-11T12:17:00.000Z");
    // A resume reads what the run recorded.
    expect(await new OptionalSteps(run, WAIT, () => now).limitedUntil("sol")).toBe("2026-11-11T12:17:00.000Z");
    // Within the run's wait of the reset it is asked again: the run waits for it then, as for any model.
    now = Date.parse("2026-11-11T11:50:00.000Z");
    expect(await steps.limitedUntil("sol")).toBeUndefined();
    // An API key out of credit gives no reset: it is not asked again in this process, and a resume asks it again.
    expect(await steps.limited("gpt-api", new ProviderUsageLimitError("Provider openai reached its usage limit (QUOTA: Provider account has no usable credit or quota)", 1, null))).toBeNull();
    expect(await steps.limitedUntil("gpt-api")).toBeNull();
    expect(await new OptionalSteps(run, WAIT, () => now).limitedUntil("gpt-api")).toBeUndefined();
  });

  it("records each move of a step once, as an event the run page reads, with when its model resets", async () => {
    const run = await store();
    const steps = new OptionalSteps(run, WAIT, () => Date.parse("2026-11-11T09:13:00.000Z"));
    await steps.limited("sol", new ProviderUsageLimitError(CODEX, 1, null));
    const words = limitedWords(await lineup(), "sol", "2026-11-11T12:17:00.000Z");
    expect(words).toBe("gpt-6.1-sol (sol, openai) limited until 2026-11-11T12:17:00.000Z");
    await Promise.all([steps.moved("secondOpinion", "sol", "gpt-api", words), steps.moved("secondOpinion", "sol", "gpt-api", words), steps.moved("critic", "sol", null, words)]);
    const events = (await run.loadEvents()).filter(({ t }) => t === "optional_step_limited");
    expect(events).toEqual([
      { t: "optional_step_limited", runId: "run-1", at: "2026-11-11T09:13:00.000Z", step: "secondOpinion", from: "sol", to: "gpt-api", resetsAt: "2026-11-11T12:17:00.000Z", detail: words },
      { t: "optional_step_limited", runId: "run-1", at: "2026-11-11T09:13:00.000Z", step: "critic", from: "sol", to: null, resetsAt: "2026-11-11T12:17:00.000Z", detail: words },
    ]);
    expect((await steps.moves("secondOpinion")).map(({ to }) => to)).toEqual(["gpt-api"]);
    const recorded = (await run.listArtifacts()).find(({ kind }) => kind === OPTIONAL_STEPS_KIND);
    expect(JSON.parse((await run.readArtifact(recorded?.artifactId ?? "")).content)).toMatchObject({ schemaVersion: 1, limited: { sol: { until: "2026-11-11T12:17:00.000Z" } }, moves: [{ step: "secondOpinion" }, { step: "critic" }] });
  });

  it("reads a limit's reset from the time the provider gave, else from the words of its reason, else none", () => {
    const now = Date.parse("2026-11-11T09:13:00.000Z");
    expect(resetOf(new ProviderUsageLimitError("limited", 1, 60_000), now)).toBe("2026-11-11T09:14:00.000Z");
    expect(resetOf(new ProviderUsageLimitError("You exceeded your current quota until 2099-01-01T00:00:00Z", 1, null), now)).toBe("2099-01-01T00:00:00.000Z");
    expect(resetOf(new ProviderUsageLimitError("credit balance is too low", 1, null), now)).toBeNull();
  });

  it("gives a second opinion to a model of another vendor than the checker's, on another login than any out, and no less capable", async () => {
    const config = await lineup();
    const standIns = (asked: string, out: readonly string[], leftOut: readonly string[] = []) => secondOpinionStandIns(config, { asked, checker: "opus", out: new Set(out), preferred: ["luna", "opus", "gemini"], leftOut: new Set(leftOut) });
    // Not Opus (the checker's vendor), not Luna (Codex, the login that is out), and no Gemini.
    expect(standIns("sol", ["sol"])).toEqual(["gpt-api"]);
    expect(standIns("sol", ["sol"], ["gpt-api"])).toEqual([]);
    // The run's own order first, then the rest by name.
    expect(standIns("gpt-api", ["gpt-api"])).toEqual(["luna", "sol"]);
  });

  it("never gives a second opinion to Gemini, which only does optional work: with no other model the issue stays open", async () => {
    const config = await lineup();
    // Gemini at its best is on another login and as capable, but a second opinion is checking.
    expect(secondOpinionStandIns(config, { asked: "sol", checker: "opus", out: new Set(["sol", "gpt-api"]), preferred: ["gemini", "luna", "opus"], leftOut: new Set() })).toEqual([]);
    // A Gemini profile is told apart by its transport as well as its vendor.
    const gemini = config.models["gemini"];
    if (gemini === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
    const relabelled = { ...config, models: { ...config.models, gemini: { ...gemini, provider: "gemini-fixture" } } };
    expect(secondOpinionStandIns(relabelled, { asked: "sol", checker: "opus", out: new Set(["sol", "gpt-api"]), preferred: [], leftOut: new Set() })).toEqual([]);
  });
});
