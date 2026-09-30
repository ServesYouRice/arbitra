import type { TraceLevel } from "../../views/plan/traceability.js";

/**
 * What the details panel shows, kept in the address as `item=<kind>:<id>` so a selected
 * issue or node is part of the link. Plan traceability names its level: `trace:<level>:<id>`.
 */
export type Selection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "issue"; readonly id: string }
  | { readonly kind: "attempt"; readonly id: string }
  | { readonly kind: "artifact"; readonly id: string }
  | { readonly kind: "trace"; readonly level: TraceLevel; readonly id: string };

const LEVELS: readonly TraceLevel[] = ["task", "validation", "issue", "finding", "evidence"];

export function parseSelection(item: string | null): Selection | null {
  if (item === null) return null;
  const index = item.indexOf(":");
  if (index <= 0) return null;
  const kind = item.slice(0, index);
  const rest = item.slice(index + 1);
  if (rest === "") return null;
  if (kind === "node" || kind === "issue" || kind === "attempt" || kind === "artifact") return { kind, id: rest };
  if (kind === "trace") {
    const split = rest.indexOf(":");
    const level = rest.slice(0, split);
    const id = rest.slice(split + 1);
    return split > 0 && id !== "" && (LEVELS as readonly string[]).includes(level) ? { kind, level: level as TraceLevel, id } : null;
  }
  return null;
}

export function selectionItem(selection: Selection): string {
  return selection.kind === "trace" ? `trace:${selection.level}:${selection.id}` : `${selection.kind}:${selection.id}`;
}
