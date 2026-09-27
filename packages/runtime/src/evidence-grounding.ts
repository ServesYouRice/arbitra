import type { RepositorySnapshot } from "./repository.js";

export interface LineEvidence { readonly path: string; readonly startLine: number; readonly endLine: number; readonly text: string }
type SnapshotFile = RepositorySnapshot["files"][number];

const MAXIMUM_ANCHOR_DISTANCE = 5;
const entities: Readonly<Record<string, string>> = { "&quot;": "\"", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };

/**
 * Exact evidence, anchored to the snapshot. Real models quote the right lines but
 * miscount them (observed live: Gemini ranges one line late, or one line too long for the
 * text they quote), and copy the
 * entity-escaped form the untrusted-content frame shows them. The quoted text must still
 * equal whole snapshot lines byte for byte and is authoritative: only the stated range, or
 * that framing escape, is corrected, and only when one occurrence starts within a few lines
 * of the stated start.
 * Returns null when the text is not in the file exactly.
 */
export function anchorLineEvidence<T extends LineEvidence>(evidence: T, file: SnapshotFile | undefined): T | null {
  if (file === undefined || evidence.startLine < 1 || evidence.endLine < evidence.startLine) return null;
  if (evidence.endLine <= file.lines.length && file.lines.slice(evidence.startLine - 1, evidence.endLine).join("\n") === evidence.text) return evidence;
  const decoded = evidence.text.replace(/&(?:quot|apos|lt|gt|amp);/gu, (entity) => entities[entity] ?? entity);
  for (const text of [...new Set([evidence.text, decoded, decoded.replace(/\n$/u, "")])]) {
    const lines = text.split("\n");
    if (text.trim() === "") continue;
    const starts: number[] = [];
    for (let start = 0; start + lines.length <= file.lines.length; start += 1) {
      if (Math.abs(start + 1 - evidence.startLine) <= MAXIMUM_ANCHOR_DISTANCE && lines.every((line, offset) => file.lines[start + offset] === line)) starts.push(start + 1);
    }
    const nearest = Math.min(...starts.map((start) => Math.abs(start - evidence.startLine)));
    const closest = starts.filter((start) => Math.abs(start - evidence.startLine) === nearest);
    if (closest.length === 1 && closest[0] !== undefined) return { ...evidence, startLine: closest[0], endLine: closest[0] + lines.length - 1, text };
  }
  return null;
}

/**
 * A cited range widened to cover its quotation. Audit evidence must appear within the lines of
 * a location it cites; real models quote the right code but cite a range that stops short
 * (observed live: Codex quoted the doc comment one line above its cited function). The quotation
 * stays authoritative and exact: the range only grows to its one occurrence near the cited lines.
 * Returns null when the text does not occur there exactly once.
 */
export function widenToQuote(range: { readonly startLine: number; readonly endLine: number }, text: string, file: SnapshotFile): { startLine: number; endLine: number } | null {
  if (text.trim() === "" || range.startLine < 1 || range.endLine < range.startLine) return null;
  const content = file.lines.join("\n");
  const lineAt = (offset: number): number => content.slice(0, offset).split("\n").length;
  const near: { start: number; end: number }[] = [];
  for (let index = content.indexOf(text); index !== -1; index = content.indexOf(text, index + 1)) {
    const start = lineAt(index); const end = lineAt(index + text.length - 1);
    if (start >= range.startLine - MAXIMUM_ANCHOR_DISTANCE && end <= range.endLine + MAXIMUM_ANCHOR_DISTANCE) near.push({ start, end });
  }
  const [only] = near;
  if (near.length !== 1 || only === undefined) return null;
  return { startLine: Math.min(range.startLine, only.start), endLine: Math.min(file.lines.length, Math.max(range.endLine, only.end)) };
}
