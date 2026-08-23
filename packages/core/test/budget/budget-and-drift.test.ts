import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BudgetGate } from "../../src/budget/budget.js";
import { estimateRun, type ResolvedEstimateConfig, type SnapshotSummary } from "../../src/budget/estimate.js";
import { detectConfigDrift, providerConfigRecord, resolvedProviderConfigHash } from "../../src/runner/config-drift.js";
import { planResumeAfterSuspension, projectedState, resumeState, RunSuspendedError, suspendForBudget } from "../../src/runner/suspension.js";

const snapshot: SnapshotSummary = { selectedFiles: 120, selectedBytes: 400_000, languageCount: 2 };

describe("budget preflight, suspension and configuration drift", () => {
  it("uses the sole estimator for display and enforcement and suspends before dispatch", () => {
    const config = fixtureConfig({ maximumTokens: 5_000, maximumCostUsd: 1 });
    const displayed = estimateRun(config, snapshot);
    const verdict = new BudgetGate().preflight(config, snapshot);
    expect(verdict.estimate).toEqual(displayed);
    expect(verdict.status).toBe("suspend");
    let providerCalls = 0;
    try {
      if (verdict.status === "suspend") suspendForBudget(verdict, ["completed-a"]);
      providerCalls += 1;
    } catch (error) {
      expect(error).toBeInstanceOf(RunSuspendedError);
      expect(projectedState(error)).toBe("SUSPENDED_BUDGET");
      const suspension = (error as RunSuspendedError).suspension;
      expect(suspension.completedActivityIds).toEqual(["completed-a"]);
      expect(resumeState(suspension, false)).toBe("SUSPENDED_BUDGET");
      expect(resumeState(suspension, true)).toBe("CREATED");
      const resumePlan = planResumeAfterSuspension(suspension, ["completed-a", "pending-b"]);
      expect(resumePlan).toEqual([
        { activityId: "completed-a", action: "replay" },
        { activityId: "pending-b", action: "execute" },
      ]);
      expect(resumePlan.filter(({ action }) => action === "execute")).toHaveLength(1);
    }
    expect(providerCalls).toBe(0);
  });

  it("labels unknown prices unknown rather than zero under a hard cap", () => {
    const config = fixtureConfig({ maximumTokens: null, maximumCostUsd: 1 }, null);
    const verdict = new BudgetGate().preflight(config, snapshot);
    expect(verdict.estimate.cost).toEqual({ minimum: null, maximum: null, currency: "USD" });
    expect(verdict.estimate.uncertainty).toContain("unknown_price:provider-a");
    expect(verdict).toMatchObject({ status: "suspend", reasons: ["cost_unknown_under_hard_cost_budget"] });
  });

  it("flags endpoint/model drift but excludes credential values from hashes", () => {
    const first = { alias: "primary", endpoint: "https://one.example/v1", modelId: "model-a", apiKeyEnv: "KEY", apiKey: "secret-one" };
    const record = providerConfigRecord("run-1", first);
    expect(detectConfigDrift([record], { ...first, apiKey: "secret-two" }).changed).toBe(false);
    expect(detectConfigDrift([record], { ...first, modelId: "model-b", apiKey: "secret-two" })).toMatchObject({ changed: true });
    expect(resolvedProviderConfigHash(first)).not.toContain("secret-one");
  });

  it("rejects direct transport imports from workflow and harness production code", async () => {
    const root = resolve(import.meta.dirname, "../../../..");
    const files = [
      ...await sourceFiles(resolve(root, "packages/workflow/src")),
      ...await sourceFiles(resolve(root, "packages/harness/src")),
    ];
    const offenders: string[] = [];
    for (const path of files) {
      const content = await readFile(path, "utf8");
      if (/providers\/src\/transports|@arbitra\/providers\/transports|\.send\(.*Transport/iu.test(content)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

function fixtureConfig(budget: ResolvedEstimateConfig["budget"], price: number | null = 10): ResolvedEstimateConfig {
  return {
    calls: [{ stage: "discovery", providerId: "provider-a", calls: 3,
      inputTokensPerCall: { minimum: 1_000, maximum: 2_000 }, outputTokensPerCall: { minimum: 500, maximum: 1_000 },
      inputUsdPerMillionTokens: price, outputUsdPerMillionTokens: price }],
    budget, allowDownscale: false,
  };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sourceFiles(resolve(directory, entry.name)) : Promise.resolve(entry.name.endsWith(".ts") ? [resolve(directory, entry.name)] : [])));
  return nested.flat();
}
