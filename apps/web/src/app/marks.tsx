import type { ReactElement } from "react";
import { gateReasonLabel, runStateLabel } from "./format.js";

/**
 * A run state in words. The recorded state code is not on the chip: it is in the run's "How it ran" details and its
 * copied report (R1, as revised October 25, 2026).
 */
export function StateChip({ state }: { readonly state: string | null }): ReactElement {
  const { text, tone } = runStateLabel(state);
  return <span className="chip" data-tone={tone ?? undefined}>{text}</span>;
}

export type Gate = { readonly status: "passed" | "failed"; readonly reasons: readonly string[] };

/** Reasons a completed run leaves for the operator to act on: work, not a fault. */
const FOR_YOU = new Set(["unresolved_issues", "blocking_plan_questions", "blocking_critic_feedback"]);
/** Reasons that describe what a completed run could not see. A source-only audit always has one. */
const LIMITS = new Set(["degraded_coverage", "degraded_critic_coverage"]);
const SHORT: Readonly<Record<string, string>> = Object.freeze({ unresolved_issues: "issues to check by hand", blocking_plan_questions: "questions for you", blocking_critic_feedback: "a critic objection" });

/**
 * The gate the CLI turns into an exit code, as one line for a list of runs. Observed live (five real projects, October
 * 2026): every completed model run failed it, for issues to check, questions only the owner could answer and the
 * source-only audit's coverage, and "gate failed" read as a broken run. A completed run is "done", with what needs the
 * operator named; anything else still reads as a failed gate. The run page says the same in its "Needs you" section.
 */
export function GateVerdict({ gate }: { readonly gate: Gate }): ReactElement {
  if (gate.status === "passed") return <p className="state" data-state="verified">gate passed</p>;
  const forYou = gate.reasons.filter((reason) => FOR_YOU.has(reason));
  const limits = gate.reasons.filter((reason) => LIMITS.has(reason));
  if (gate.reasons.length === 0 || forYou.length + limits.length < gate.reasons.length) return <p className="state" data-state="refuted">gate failed · {gate.reasons.map(gateReasonLabel).join(" · ") || "no reason recorded"}</p>;
  if (forYou.length === 0) return <p className="state">done · coverage has limits</p>;
  return <p className="state" data-state="attention">done · needs you · {forYou.map((code) => SHORT[code] ?? gateReasonLabel(code)).join(" · ")}</p>;
}
