import { describe, expect, it } from "vitest";
import type { AuditorProgress } from "@arbitra/schemas/run-progress.js";
import type { Orchestrator } from "../src/orchestrator.js";
import { runReport } from "../src/run-report.js";

const yieldOf = (auditorId: string, modelId: string, findings: number) => ({ auditorId, modelId, findings, confirmed: 3, confirmedAlone: 1, discoveryTokens: 2_400_000 });
const progressOf = (auditorId: string, coverage: AuditorProgress["coverage"]): AuditorProgress => ({ auditorId, modelId: null, partsRead: 0, partsDeclined: 0, findings: 0, finished: true, coverage });

/** The parts of an orchestrator a run's report reads. */
function orchestrator(auditors: readonly AuditorProgress[], planResults: unknown = null): Orchestrator {
  return {
    overview: async () => ({ mode: "audit", workflowId: "audit-balanced", state: "COMPLETED", reason: null, live: false, gate: null, createdAt: null, updatedAt: null, scope: {}, configuration: null }),
    modelTraces: async () => [],
    metrics: async () => ({ confirmedYield: { candidates: 9, confirmed: 6, confirmedBySeverity: {}, rejected: 1, unsettled: 1, acceptedUnchecked: 0, notChecked: 1, tokens: null, tokensPerConfirmed: null,
      auditors: [yieldOf("auditor-a", "claude-opus-5-5", 40), yieldOf("auditor-b", "gemini-3.8-flash-medium", 7), yieldOf("auditor-c", "gpt-6.1-sol", 12)] }, planResults }),
    progress: async () => ({ auditors }),
    keepAwake: () => null,
    slept: async () => [],
  } as unknown as Orchestrator;
}

describe("a run's report", () => {
  it("says how many of its units each finder answered, and why the rest were not examined", async () => {
    // Observed live (October 26, 2026, agy 1.4.7): Gemini answered 4 of the 32 units Claude audited, and no line of the report said so.
    const text = await runReport(orchestrator([progressOf("auditor-a", { units: 32, answered: 32, notExamined: {} }), progressOf("auditor-b", { units: 32, answered: 27, notExamined: { reply_rejected: 2, provider_failed: 3 } }),
      progressOf("auditor-c", null)]), "run-1", null, "test");
    const lines = text.split("\n");
    expect(lines).toContain("  auditor-a (claude-opus-5-5): 40 findings · 3 confirmed · 1 confirmed that no other auditor found · 32 of 32 units answered · discovery 2.4M tokens");
    expect(lines).toContain("  auditor-b (gemini-3.8-flash-medium): 7 findings · 3 confirmed · 1 confirmed that no other auditor found · 27 of 32 units answered (5 not examined: provider_failed 3, reply_rejected 2) · discovery 2.4M tokens");
    // A run that recorded no units says nothing of them, rather than a number it cannot know.
    expect(lines).toContain("  auditor-c (gpt-6.1-sol): 12 findings · 3 confirmed · 1 confirmed that no other auditor found · discovery 2.4M tokens");
  });

  it("says what a verification question cost: its calls, tool calls, and what the first call and the later calls took from the cache", async () => {
    // A question's first call wrote 48,000 tokens to the cache and read none in a recorded run of 197 questions (October 31, 2026).
    const trace = (activityId: string, input: number, read: number, written: number, tools: number, errors = 0) => ({ activityId, nodeId: "verification", outcome: "success", durationMs: 1_000, modelId: "m", error: null, refusal: null,
      tokenUsage: { inputTokens: input, outputTokens: 100, cacheReadTokens: read, cacheWriteTokens: written }, toolCallCount: tools, toolCallErrors: errors });
    const traces = [trace("verification/C-1/question/turn-0", 40_000, 0, 40_000, 2), trace("verification/C-1/question/turn-1", 42_000, 40_000, 2_000, 1, 1), trace("verification/C-1/question/turn-2", 43_000, 42_000, 1_000, 0),
      trace("verification/C-2/question/turn-0", 20_000, 4_000, 16_000, 0), trace("planner/turn-0", 9_000, 0, 9_000, 0)];
    const lines = (await runReport({ ...orchestrator([]), modelTraces: async () => traces } as unknown as Orchestrator, "run-1", null, "test")).split("\n");
    const at = lines.indexOf("verification questions");
    expect(lines.slice(at, at + 4)).toEqual(["verification questions", "  2 questions · 4 calls (2.0 a question) · 3 tool calls (1 failed)",
      "  first call of a question: 30K tokens in, 2K read from the cache, 28K written to it", "  later calls: 43K tokens in, 41K read from the cache, 2K written to it"]);
    expect(lines.some((line) => line.startsWith("verification questions") && lines.indexOf(line) !== at)).toBe(false);
  });

  it("says a saved plan has not been carried out yet, rather than counting zero results", async () => {
    // Observed (October 27, 2026, the MacBook run's report): a plan just saved read "0 of 111 issues reported · fixed 0 · ...".
    const saved = { issues: 111, reported: 0, provenByFailingTest: 0, notProvenByTest: 0, checkedEndToEnd: 0, results: { fixed: 0, not_reproducible: 0 }, foundWhileFixing: { reported: 0, provenByFailingTest: 0 } };
    const lines = (await runReport(orchestrator([], saved), "run-1", null, "test")).split("\n");
    expect(lines).toContain("  not yet: none of the plan's 111 issues has a result");
    expect(lines.some((line) => line.includes("0 of 111 issues reported"))).toBe(false);
  });
});
