import type { ReactElement } from "react";
import { gateReasonLabel, runStateLabel } from "./format.js";

/** A run state in words, with the recorded state code beside it; `live`: this control plane is executing it. */
export function StateChip({ state, live = false }: { readonly state: string | null; readonly live?: boolean }): ReactElement {
  const { text, tone } = runStateLabel(state, live);
  // The space keeps words and code apart for a screen reader; flex layout sets the visual gap.
  return <span className="chip" data-tone={tone ?? undefined}>{text}{state === null ? null : <>{" "}<span className="chip__code">{state}</span></>}</span>;
}

export type Gate = { readonly status: "passed" | "failed"; readonly reasons: readonly string[] };

/** Reasons a completed run leaves for the operator to act on: work, not a fault. */
const FOR_YOU = new Set(["unresolved_issues", "blocking_plan_questions", "blocking_critic_feedback"]);
/** Reasons that describe what a completed run could not see. A source-only audit always has one. */
const LIMITS = new Set(["degraded_coverage", "degraded_critic_coverage"]);
const SHORT: Readonly<Record<string, string>> = Object.freeze({ unresolved_issues: "issues to check by hand", blocking_plan_questions: "questions for you", blocking_critic_feedback: "a critic objection" });

/**
 * The gate the CLI turns into an exit code, read for a person. Observed live (five real projects, October 2026): every
 * completed model run failed it, for issues to check, questions only the owner could answer and the source-only
 * audit's coverage, and "gate failed" read as a broken run. A completed run is now "done", with what needs the
 * operator listed as work; anything else still reads as a failed gate. `detail` adds counts by reason code.
 */
export function GateVerdict({ gate, compact = false, detail = {} }: { readonly gate: Gate; readonly compact?: boolean; readonly detail?: Readonly<Record<string, string>> }): ReactElement {
  if (gate.status === "passed") return <p className="state" data-state="verified">gate passed</p>;
  const forYou = gate.reasons.filter((reason) => FOR_YOU.has(reason));
  const limits = gate.reasons.filter((reason) => LIMITS.has(reason));
  const reason = (code: string) => <li key={code}>{gateReasonLabel(code)}{detail[code] === undefined ? "" : ` · ${detail[code]}`} <code className="gate__code">{code}</code></li>;
  if (gate.reasons.length === 0 || forYou.length + limits.length < gate.reasons.length) {
    if (compact) return <p className="state" data-state="refuted">gate failed · {gate.reasons.map(gateReasonLabel).join(" · ") || "no reason recorded"}</p>;
    return <div className="state gate" data-state="refuted">
      <p>gate failed</p>
      <ul aria-label="gate reasons" className="plain-list">{gate.reasons.map(reason)}</ul>
    </div>;
  }
  const heading = forYou.length === 0 ? "done · coverage has limits" : "done · needs you";
  if (compact) return <p className="state" data-state={forYou.length === 0 ? undefined : "attention"}>{forYou.length === 0 ? heading : `${heading} · ${forYou.map((code) => SHORT[code] ?? gateReasonLabel(code)).join(" · ")}`}</p>;
  return <div className="state gate" data-state={forYou.length === 0 ? undefined : "attention"}>
    <p>{heading}</p>
    {forYou.length === 0 ? null : <ul aria-label="what needs you" className="plain-list">{forYou.map(reason)}</ul>}
    {limits.length === 0 ? null : <ul aria-label="what the run could not see" className="plain-list">{limits.map(reason)}</ul>}
    <p className="note">The command-line gate fails on these, so the CLI exits 1 for this run.</p>
  </div>;
}
