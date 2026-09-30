/**
 * Plain words for recorded codes. Every label here is shown beside the code it translates,
 * never instead of it: the code is the record, the words are a reading aid (R1).
 */

/** A state token, or `attention` for "the operator must act", which carries no semantic hue. */
export type Tone = "verified" | "dissent" | "refuted" | "tainted" | "unexamined" | "degraded" | "attention";

const PHASES: Readonly<Record<string, string>> = Object.freeze({
  SNAPSHOTTED: "snapshot taken", PREFLIGHT_COMPLETE: "preflight done", DISCOVERY_RUNNING: "discovery", DISCOVERY_COMPLETE: "discovery done",
  CLUSTERED: "clustering done", PEER_REVIEW_RUNNING: "peer review", CONSENSUS_PRELIMINARY: "consensus", VERIFYING: "verification",
  CONSENSUS_COMPLETE: "consensus done", PLANNING: "planning", PLAN_REVIEW: "plan review", PLAN_REVISION: "plan revision", COMPILED: "writing the handoff",
});

export function runStateLabel(state: string | null): { readonly text: string; readonly tone: Tone | null } {
  switch (state) {
    case null: return { text: "unreadable", tone: "degraded" };
    case "CREATED": return { text: "starting", tone: null };
    case "COMPLETED": return { text: "finished", tone: null };
    case "FAILED": return { text: "failed", tone: "refuted" };
    case "BLOCKED": return { text: "waiting for your decision", tone: "attention" };
    case "CANCELLED": return { text: "cancelled", tone: "unexamined" };
    case "SUSPENDED_BUDGET": return { text: "paused · token budget reached", tone: "degraded" };
    case "SUSPENDED_RATE_LIMIT": return { text: "paused · rate limited", tone: "degraded" };
    default: return { text: `running · ${PHASES[state] ?? state.toLowerCase().replaceAll("_", " ")}`, tone: null };
  }
}

/** Still doing work: worth watching and cancellable. Every other state waits on the operator or is final. */
export function isActive(state: string | null): boolean {
  return state !== null && !["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "SUSPENDED_BUDGET", "SUSPENDED_RATE_LIMIT"].includes(state);
}

const GATE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  run_not_completed: "the run did not complete",
  no_canonical_issue_set: "no issue set was produced",
  unresolved_issues: "some issues are still unresolved",
  degraded_coverage: "coverage is incomplete",
  blocking_plan_questions: "the plan leaves a blocking question open",
  blocking_critic_feedback: "the critic raised a blocking objection",
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
