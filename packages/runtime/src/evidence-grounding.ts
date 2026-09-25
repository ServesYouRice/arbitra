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
