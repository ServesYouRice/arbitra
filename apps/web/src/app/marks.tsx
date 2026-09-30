import type { ReactElement } from "react";
import { gateReasonLabel, runStateLabel } from "./format.js";

/** A run state in words, with the recorded state code beside it. */
export function StateChip({ state }: { readonly state: string | null }): ReactElement {
  const { text, tone } = runStateLabel(state);
  // The space keeps words and code apart for a screen reader; flex layout sets the visual gap.
  return <span className="chip" data-tone={tone ?? undefined}>{text}{state === null ? null : <>{" "}<span className="chip__code">{state}</span></>}</span>;
}

export type Gate = { readonly status: "passed" | "failed"; readonly reasons: readonly string[] };

/** The gate the CLI turns into an exit code: each reason in words and as recorded. */
export function GateVerdict({ gate, compact = false }: { readonly gate: Gate; readonly compact?: boolean }): ReactElement {
  if (gate.status === "passed") return <p className="state" data-state="verified">gate passed</p>;
  if (compact) return <p className="state" data-state="refuted">gate failed · {gate.reasons.map(gateReasonLabel).join(" · ") || "no reason recorded"}</p>;
  return <div className="state gate" data-state="refuted">
    <p>gate failed</p>
    <ul aria-label="gate reasons" className="plain-list">{gate.reasons.map((reason) => <li key={reason}>{gateReasonLabel(reason)} <code className="gate__code">{reason}</code></li>)}</ul>
  </div>;
}
