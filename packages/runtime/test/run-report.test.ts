import { describe, expect, it } from "vitest";
import type { AuditorProgress } from "@arbitra/schemas/run-progress.js";
import type { Orchestrator } from "../src/orchestrator.js";
import { runReport } from "../src/run-report.js";

const yieldOf = (auditorId: string, modelId: string, findings: number) => ({ auditorId, modelId, findings, confirmed: 3, confirmedAlone: 1, discoveryTokens: 2_400_000 });
const progressOf = (auditorId: string, coverage: AuditorProgress["coverage"]): AuditorProgress => ({ auditorId, modelId: null, partsRead: 0, partsDeclined: 0, findings: 0, finished: true, coverage });

/** The parts of an orchestrator a run's report reads. */
function orchestrator(auditors: readonly AuditorProgress[]): Orchestrator {
  return {
    overview: async () => ({ mode: "audit", workflowId: "audit-balanced", state: "COMPLETED", reason: null, live: false, gate: null, createdAt: null, updatedAt: null, scope: {}, configuration: null }),
    modelTraces: async () => [],
    metrics: async () => ({ confirmedYield: { candidates: 9, confirmed: 6, confirmedBySeverity: {}, rejected: 1, unsettled: 1, acceptedUnchecked: 0, notChecked: 1, tokens: null, tokensPerConfirmed: null,
      auditors: [yieldOf("auditor-a", "claude-opus-5-5", 40), yieldOf("auditor-b", "gemini-3.8-flash-medium", 7), yieldOf("auditor-c", "gpt-6.1-sol", 12)] }, planResults: null }),
    progress: async () => ({ auditors }),
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
});
