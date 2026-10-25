import { redactSecrets } from "@arbitra/security/redaction";
import type { RepositorySnapshot } from "./repository.js";

export interface LineEvidence { readonly path: string; readonly startLine: number; readonly endLine: number; readonly text: string }
type SnapshotFile = RepositorySnapshot["files"][number];
type Lines = { readonly lines: readonly string[] };

const MAXIMUM_ANCHOR_DISTANCE = 5;
const entities: Readonly<Record<string, string>> = { "&quot;": "\"", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };

/** A quotation as the source holds it, when a model copied the entities the untrusted-content frame shows. */
export function unframedQuote(text: string): string { return text.replace(/&(?:quot|apos|lt|gt|amp);/gu, (entity) => entities[entity] ?? entity); }

/**
 * The lines a quotation holding a redaction marker is matched against: the file as the model was shown it, each line
 * with its secrets masked. Found by arbitra's audit of itself (October 19, 2026): a model only ever sees a line with a
 * secret masked, and its reply is masked again before validation, so a quotation of such a line could never equal
 * the file and exact-quote grounding refused it. The text matched there is returned masked, so no secret enters a
 * stored answer.
 */
function asShown(file: SnapshotFile): Lines { return { lines: file.lines.map((line) => redactSecrets(line).text) }; }
function quotesMasked(text: string): boolean { return text.includes("[REDACTED:"); }

/**
 * Exact evidence, anchored to the snapshot. Real models quote the right lines but
 * miscount them (observed live: Gemini ranges one line late, or one line too long for the
 * text they quote), and copy the
 * entity-escaped form the untrusted-content frame shows them. The quoted text must still
 * equal whole snapshot lines character for character and is authoritative: only the stated range, or
 * that framing escape, is corrected, and only when one occurrence starts within a few lines
 * of the stated start.
 * Both sides are compared in Unicode normal form C, the form the prompt compiler sends source in: a model copies the
 * composed "é" it was shown, while the file may hold "e" and a combining accent. The text returned is
 * then the file's own, or the file's as shown when it quotes a line with a secret masked.
 * Returns null when the text is not in the file exactly.
 */
export function anchorLineEvidence<T extends LineEvidence>(evidence: T, file: SnapshotFile | undefined): T | null {
  if (file === undefined || evidence.startLine < 1 || evidence.endLine < evidence.startLine) return null;
  return anchorIn(evidence, file) ?? (quotesMasked(evidence.text) ? anchorIn(evidence, asShown(file)) : null);
}

function anchorIn<T extends LineEvidence>(evidence: T, file: Lines): T | null {
  const stated = evidence.endLine <= file.lines.length ? file.lines.slice(evidence.startLine - 1, evidence.endLine).join("\n") : null;
  if (stated === evidence.text) return evidence;
  if (stated !== null && stated.normalize("NFC") === evidence.text.normalize("NFC")) return { ...evidence, text: stated };
  const source = file.lines.map((line) => line.normalize("NFC"));
  const decoded = evidence.text.replace(/&(?:quot|apos|lt|gt|amp);/gu, (entity) => entities[entity] ?? entity);
  for (const text of [...new Set([evidence.text, decoded, decoded.replace(/\n$/u, "")].map((candidate) => candidate.normalize("NFC")))]) {
    const lines = text.split("\n");
    if (text.trim() === "") continue;
    const starts: number[] = [];
    for (let start = 0; start + lines.length <= source.length; start += 1) {
      if (Math.abs(start + 1 - evidence.startLine) <= MAXIMUM_ANCHOR_DISTANCE && lines.every((line, offset) => source[start + offset] === line)) starts.push(start + 1);
    }
    const nearest = Math.min(...starts.map((start) => Math.abs(start - evidence.startLine)));
    const closest = starts.filter((start) => Math.abs(start - evidence.startLine) === nearest);
    if (closest.length === 1 && closest[0] !== undefined) return { ...evidence, startLine: closest[0], endLine: closest[0] + lines.length - 1, text: file.lines.slice(closest[0] - 1, closest[0] - 1 + lines.length).join("\n") };
  }
  return null;
}

/**
 * A cited range widened to cover its quotation. Audit evidence must appear within the lines of
 * a location it cites; real models quote the right code but cite a range that stops short
 * (observed live: Codex quoted the doc comment one line above its cited function). The quotation
 * stays authoritative and exact: the range only grows to its one occurrence near the cited lines.
 * Compared in normal form C, as `anchorLineEvidence`; normalizing never adds or removes a line break, so line numbers hold.
 * A quotation holding a redaction marker is also sought in the file as shown, as `anchorLineEvidence`.
 * Returns null when the text does not occur there exactly once.
 */
export function widenToQuote(range: { readonly startLine: number; readonly endLine: number }, text: string, file: SnapshotFile): { startLine: number; endLine: number } | null {
  if (text.trim() === "" || range.startLine < 1 || range.endLine < range.startLine) return null;
  return widenIn(range, text, file) ?? (quotesMasked(text) ? widenIn(range, text, asShown(file)) : null);
}

function widenIn(range: { readonly startLine: number; readonly endLine: number }, text: string, file: Lines): { startLine: number; endLine: number } | null {
  // Only an occurrence within these lines counts, so only they are searched, with the break after the last of them.
  // Each occurrence anywhere in the file once split all the text before it into lines: quadratic in a repetitive file.
  const first = Math.max(1, range.startLine - MAXIMUM_ANCHOR_DISTANCE); const last = Math.min(file.lines.length, range.endLine + MAXIMUM_ANCHOR_DISTANCE);
  const content = file.lines.slice(first - 1, last).join("\n").normalize("NFC") + (last < file.lines.length ? "\n" : "");
  const quote = text.normalize("NFC");
  // An occurrence ends on the line of its last character, a closing break included.
  const breaks = quote.slice(0, -1).split("\n").length - 1;
  const starts: number[] = [];
  let line = first; let counted = 0;
  for (let index = content.indexOf(quote); index !== -1; index = content.indexOf(quote, index + 1)) {
    for (let next = content.indexOf("\n", counted); next !== -1 && next < index; next = content.indexOf("\n", counted)) { line += 1; counted = next + 1; }
    starts.push(line);
  }
  const [only] = starts;
  if (starts.length !== 1 || only === undefined) return null;
  return { startLine: Math.min(range.startLine, only), endLine: Math.min(file.lines.length, Math.max(range.endLine, only + breaks)) };
}
