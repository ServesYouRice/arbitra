/**
 * Lines of a file as a person reads them: "line 20" for one line, "lines 20–24" for a range and "lines 3, 20–24" for
 * several; and a place in a file as "src/a.ts:20" or "src/a.ts:20–24". The plan export and the web app write them from
 * here. Observed live (November 11, 2026): a plan's note on its one instruction-shaped line said "lines 20". This
 * module imports nothing, so the web app bundles it as it is.
 *
 * The premise check shipped with a plan keeps its own copy of the place form, in plain ASCII ("src/a.ts:20-24"): its
 * script refers to nothing outside itself and prints to any console (`premise-check.ts`).
 */
export interface LineSpan { readonly startLine: number; readonly endLine: number }

/** "line 20", "lines 20–24", or "lines 3, 20–24" for several spans; empty for none. */
export function lineSpan(spans: readonly LineSpan[]): string {
  const [first] = spans;
  if (first === undefined) return "";
  return `${spans.length === 1 && first.endLine <= first.startLine ? "line" : "lines"} ${spans.map(range).join(", ")}`;
}

/** A place in a file: "src/a.ts:20", or "src/a.ts:20–24" for more than one line. */
export function placeSpan(path: string, span: LineSpan): string { return `${path}:${range(span)}`; }

function range({ startLine, endLine }: LineSpan): string { return endLine > startLine ? `${startLine}–${endLine}` : `${startLine}`; }
