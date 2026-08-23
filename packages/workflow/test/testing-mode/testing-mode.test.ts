import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prioritiseGaps, testInventory, testTasks } from "../../src/nodes/test-inventory.js";

describe("plan-only Testing Mode", () => {
  it("derives inventory deterministically and selects only production-risk-justified gaps", async () => {
    const snapshot = [{ path: "src/auth.ts", kind: "file" as const }, { path: "test/auth.unit.test.ts", kind: "file" as const }, { path: "vitest.config.ts", kind: "file" as const }];
    const report = testInventory(snapshot);
    expect(testInventory([...snapshot].reverse())).toEqual(report);
    const requests: unknown[] = [];
    const gaps = await prioritiseGaps(report, [{ id: "auth", paths: ["src/auth.ts"], categories: ["authorization", "race-condition"], severity: "critical", failureModes: ["cross-tenant access", "refresh race"] }], { async select(input) { requests.push(input); return input.candidates.map(({ id }) => id); } });
    expect(requests).toEqual([expect.objectContaining({ capability: "frontier", forbiddenMetrics: ["raw_test_count", "coverage_percentage"] })]);
    expect(gaps).toHaveLength(2);
    expect(gaps.every(({ rationale, productionRisk }) => rationale.includes("auth") && productionRisk.startsWith("critical:"))).toBe(true);
    const tasks = testTasks(gaps, "pnpm test");
    expect(tasks.every(({ verification }) => verification.commands.every(({ executionPolicy }) => executionPolicy === "derived_repository_script"))).toBe(true);
    expect(tasks.find(({ gapIds }) => gapIds.includes("GAP-auth-2"))?.routing.capability).toBe("frontier");
  });

  it("exposes no mutation or execution capability and leaves the scoped repository hash unchanged", () => {
    const presetBytes = readFileSync(new URL("../../src/presets/testing-plan.json", import.meta.url));
    const preset = JSON.parse(presetBytes.toString("utf8")) as { readOnly: boolean; capabilities: Record<string, unknown> };
    expect(preset).toMatchObject({ readOnly: true, capabilities: { worktree: false, writeScope: false, shell: false, sandbox: false, advisorRuntime: false, writeTools: [] } });
    const before = hash([{ path: "src/auth.ts", bytes: "source" }, { path: "README.md", bytes: "docs" }]);
    const afterRun = hash([{ path: "implementation/manifest.json", bytes: "plan" }, { path: ".runs/run.jsonl", bytes: "journal" }, { path: "README.md", bytes: "docs" }, { path: "src/auth.ts", bytes: "source" }]);
    expect(afterRun).toBe(before);
  });

  it("pins a risk-first protocol with no coverage-percentage objective", () => {
    const protocol = readFileSync(new URL("../../../protocols/assets/testing-audit/1.0.0/protocol.md", import.meta.url), "utf8");
    expect(protocol).toContain("production-risk");
    expect(protocol).toContain("Never rank by raw test count or coverage percentage");
    expect(protocol).toContain("Do not write tests");
  });
});

function hash(entries: readonly { path: string; bytes: string }[]): string {
  const included = entries.filter(({ path }) => !/^(?:implementation|\.runs)\//u.test(path)).sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(included)).digest("hex");
}

