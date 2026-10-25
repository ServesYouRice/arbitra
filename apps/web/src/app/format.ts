/**
 * Plain words for recorded codes. A main line shows the words alone; the code itself is shown in the details and the
 * copied report, where a person checking the record looks for it (R1, as revised October 25, 2026).
 */

/** A state token, or `attention` for "the operator must act", which carries no semantic hue. */
export type Tone = "verified" | "dissent" | "refuted" | "tainted" | "unexamined" | "degraded" | "attention";

/**
 * A run's state in one word per idea: running · paused for usage · needs you · done · failed, and cancelled. Every
 * working state reads "running"; which step it is in is the watch line's to say. Since the runner records each stage,
 * CREATED lasts only until the first stage starts, so it no longer reads "starting".
 */
export function runStateLabel(state: string | null): { readonly text: string; readonly tone: Tone | null } {
  switch (state) {
    case null: return { text: "unreadable", tone: "degraded" };
    case "COMPLETED": return { text: "done", tone: null };
    case "FAILED": return { text: "failed", tone: "refuted" };
    case "BLOCKED": return { text: "needs you", tone: "attention" };
    case "CANCELLED": return { text: "cancelled", tone: "unexamined" };
    case "SUSPENDED_BUDGET": return { text: "paused at its token limit", tone: "degraded" };
    case "SUSPENDED_RATE_LIMIT": return { text: "paused for usage", tone: "degraded" };
    default: return { text: "running", tone: null };
  }
}

/** Still doing work: worth watching and cancellable. Every other state waits on the operator or is final. */
export function isActive(state: string | null): boolean {
  return state !== null && !["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "SUSPENDED_BUDGET", "SUSPENDED_RATE_LIMIT"].includes(state);
}

const GATE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  run_not_completed: "the run did not complete",
  no_canonical_issue_set: "no issue set was produced",
  unresolved_issues: "issues the source could not settle: check them by hand",
  degraded_coverage: "coverage is incomplete",
  blocking_plan_questions: "questions in the plan only you can answer",
  blocking_critic_feedback: "a critic objection the plan does not answer",
  degraded_critic_coverage: "the critic could not review the whole plan",
  no_feature_plan_result: "no Feature plan was recorded",
  feature_plan_review_failed: "the Feature plan failed its review",
  no_implementation_handoff: "no implementation handoff was produced",
  no_testing_plan_result: "no Testing plan was recorded",
  testing_plan_failed: "the Testing plan failed",
  no_testing_execution_result: "no Testing execution result was recorded",
  testing_execution_failed: "Testing execution failed",
  testing_execution_plan_mismatch: "execution does not match the plan that passed",
  no_verified_testing_handoff: "no verified change set was produced",
});

/** The gate's reason in words where it is known; parameterised reasons keep their subject. */
export function gateReasonLabel(code: string): string {
  const [head, subject] = splitReason(code);
  if (head === "checkpoint_pending") return `checkpoint ${subject} is still waiting for a decision`;
  if (head === "checkpoint_rejected") return `checkpoint ${subject} was rejected`;
  if (head === "gate_failed") return `gate ${subject} failed`;
  return GATE_REASONS[code] ?? code.replaceAll("_", " ");
}
function splitReason(code: string): readonly [string, string] {
  const index = code.indexOf(":");
  return index === -1 ? [code, ""] : [code.slice(0, index), code.slice(index + 1)];
}

export const MODE_LABELS: Readonly<Record<"audit" | "feature" | "testing", string>> = Object.freeze({ audit: "Audit", feature: "Feature", testing: "Testing" });

/** The mode a run's workflow implies, for the moment before its recorded settings load. */
export function modeOfWorkflow(workflowId: string | undefined): "audit" | "feature" | "testing" {
  if (workflowId === "feature-simple") return "feature";
  if (workflowId === "testing-plan" || workflowId === "testing-execute") return "testing";
  return "audit";
}

/** The run identifier without its fixed prefix, cut to a length that stays unique in practice. */
export function shortRunId(runId: string): string {
  const bare = runId.startsWith("run-") ? runId.slice(4) : runId;
  return bare.length > 8 ? bare.slice(0, 8) : bare;
}

/** A recorded time in the viewer's locale; absent times say so rather than render a blank. */
export function formatTime(iso: string | null): string {
  if (iso === null) return "time unavailable";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The last path segment, which is how operators name their checkouts. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || path;
}

/**
 * Artifact kinds carry content hashes (`compiled-prompt-7d61…`). The name keeps the recorded
 * kind and the first hash characters, so two artifacts of one kind stay distinct.
 */
export function artifactName(kind: string): { readonly name: string; readonly hash: string | null } {
  const match = /^(.*?)-([0-9a-f]{16,})(-.*)?$/u.exec(kind);
  if (match === null) return { name: kind, hash: null };
  return { name: `${match[1] ?? kind}${match[3] ?? ""}`, hash: match[2]?.slice(0, 8) ?? null };
}

/** Activity and node paths embed 64-character hashes; eight characters identify them on screen. */
export function shortPath(path: string): string {
  return path.replace(/[0-9a-f]{16,}/gu, (hash) => `${hash.slice(0, 8)}…`);
}
