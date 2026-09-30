import type { RunTab } from "../../app/router.js";

export const TAB_LABELS: Readonly<Record<RunTab, string>> = Object.freeze({ overview: "Overview", issues: "Issues", plan: "Plan", requirements: "Requirements", execution: "Execution", activity: "Activity", evaluation: "Evaluation" });

/** Only the tabs that can hold something for a run of this mode. */
export function tabsFor(mode: "audit" | "feature" | "testing"): readonly RunTab[] {
  if (mode === "feature") return ["overview", "requirements", "plan", "activity", "evaluation"];
  if (mode === "testing") return ["overview", "plan", "execution", "activity", "evaluation"];
  return ["overview", "issues", "plan", "activity", "evaluation"];
}
