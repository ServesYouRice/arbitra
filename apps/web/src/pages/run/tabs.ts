import type { RunTab } from "../../app/router.js";

export const TAB_LABELS: Readonly<Record<RunTab, string>> = Object.freeze({ summary: "Summary", issues: "Issues", plan: "Plan", results: "Results", "how-it-ran": "How it ran",
  requirements: "Requirements", execution: "Execution", activity: "Activity", evaluation: "Evaluation" });

/** The tabs a run of this mode shows: only those that can hold something for it. */
export function tabsFor(mode: "audit" | "feature" | "testing"): readonly RunTab[] {
  if (mode === "feature") return ["summary", "requirements", "plan", "how-it-ran"];
  if (mode === "testing") return ["summary", "plan", "execution", "how-it-ran"];
  return ["summary", "issues", "plan", "results", "how-it-ran"];
}

/** The run's records, one click down from "How it ran": the executed graph, every model call and artifact, and the evaluation. */
export const RECORD_TABS: readonly RunTab[] = Object.freeze(["activity", "evaluation"]);

/** Every place a run of this mode has: its tabs and its records. */
export function placesFor(mode: "audit" | "feature" | "testing"): readonly RunTab[] {
  return [...tabsFor(mode), ...RECORD_TABS];
}
