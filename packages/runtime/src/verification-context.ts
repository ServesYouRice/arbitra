import { posix } from "node:path";

/**
 * The source a verification question is handed beside the files its candidate cites: where the names used at the cited
 * lines are defined, and who calls the function the cited lines sit in, found by text and without a model. Measured on
 * a recorded run (nananananana, October 31, 2026; 197 questions on 601 calls): 417 of the 914 tool calls read a file the
 * question did not cite, and with this context 91 of them (22%) land on a place it supplies, for 4 KB a question.
 *
 * It only adds. The model still reads anything through the source tools, and the lookup guesses from names alone: a
 * name defined in several places, a name the cited files define themselves and a name of a language it cannot read
 * are left out, never resolved wrongly. The excerpts are untrusted source like the files beside them; the question
 * carries them inside its framed input.
 */
export interface ContextFile { readonly path: string; readonly lines: readonly string[] }
export interface ContextLocation { readonly path: string; readonly startLine: number; readonly endLine: number }
export interface RelatedExcerpt {
  /** `path:first-last`: not a bare path, so the allocation that decides which files a stage carries does not read it as a cited file. */
  readonly at: string;
  readonly why: string;
  /** The lines, each as `number: text`, numbered as in the file. */
  readonly content: string;
  readonly trust: "untrusted_data";
}
export interface RelatedSource { readonly note: string; readonly definitions: readonly RelatedExcerpt[]; readonly callers: readonly RelatedExcerpt[] }

export const RELATED_SOURCE_LIMITS = Object.freeze({
  /** Definitions supplied, the lines each shows at most, and the places one name may be defined before it counts as ambiguous. */
  definitions: 4, definitionLines: 25, sitesPerName: 3,
  /** Call sites supplied in all, per function, and the lines around each. */
  callers: 6, callersPerName: 3, callerContext: 2,
  /** Lines of a cited place read for names, and the cited places read. */
  locationLines: 80, locations: 8,
  /** What the whole of it may add to a question, in bytes of excerpt text. */
  bytes: 8_000,
});

const NOTE = "Found by text search in files the findings do not cite: where a name used at the cited lines is defined, and where the function the cited lines sit in is called. It is a convenience, not a complete list of definitions or callers; read anything else you need with the source tools.";

/** Definition lines of the languages arbitra reads most: Elixir, JavaScript and TypeScript, Python and Ruby, Go, Rust. */
const DEFINITIONS: readonly RegExp[] = [
  /^\s*(?:def|defp|defmacro|defmacrop|defdelegate|defguard|defmodule)\s+([A-Za-z_][\w.]*[?!]?)/u,
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/u,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/u,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/u,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/u,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/u,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/u,
];
/** Names too common to say anything: they are defined everywhere, or are the language's own words. */
const COMMON = new Set(["after", "all", "async", "attrs", "await", "before", "call", "case", "class", "conn", "const", "create", "default", "delete", "else", "end", "export", "false", "from", "function", "handle", "import", "index", "init", "inspect", "interface", "list", "name", "nil", "null", "opts", "params", "post", "render", "return", "run", "show", "socket", "start", "state", "this", "true", "type", "update", "value", "when", "with"]);
const MINIMUM_NAME = 4;
const MAXIMUM_CALLER_HITS = 25;

interface Site { readonly path: string; readonly line: number }

function definitionOf(line: string): string | null {
  for (const pattern of DEFINITIONS) { const match = pattern.exec(line); if (match?.[1] !== undefined) return match[1].split(".").pop() ?? null; }
  return null;
}
const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => /^\s*(?:#|\/\/|\*|\/\*|@doc|@moduledoc|--)/u.test(line);
const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** How many leading directories two paths share: a caller next to the cited file is likelier the one meant. */
function nearness(left: string, right: string): number {
  const a = posix.dirname(left).split("/"); const b = posix.dirname(right).split("/"); let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * A lookup over one snapshot, built on first use and reused by every question of the stage. The same locations in the
 * same snapshot always give the same context.
 */
export function relatedSourceFinder(files: readonly ContextFile[]): (locations: readonly ContextLocation[]) => RelatedSource | null {
  const byPath = new Map(files.map((file) => [file.path, file]));
  let definitions: Map<string, Site[]> | undefined;
  const texts = new Map<string, string>();
  const callerCache = new Map<string, Site[]>();
  const definitionIndex = (): Map<string, Site[]> => {
    if (definitions !== undefined) return definitions;
    definitions = new Map();
    for (const { path, lines } of [...files].sort((a, b) => a.path < b.path ? -1 : 1)) {
      lines.forEach((line, index) => { const name = definitionOf(line); if (name !== null && !COMMON.has(name)) { const sites = definitions?.get(name) ?? []; sites.push({ path, line: index + 1 }); definitions?.set(name, sites); } });
    }
    return definitions;
  };
  const textOf = (file: ContextFile): string => { const known = texts.get(file.path); if (known !== undefined) return known; const text = file.lines.join("\n"); texts.set(file.path, text); return text; };
  /** Where a name is used and not defined, outside the cited files, nearest the first cited file first. */
  const callersOf = (name: string, cited: ReadonlySet<string>, near: string): Site[] => {
    const key = `${name}\0${near}\0${[...cited].join("\0")}`;
    const known = callerCache.get(key); if (known !== undefined) return known;
    const word = new RegExp(`(?<![\\w$])${escaped(name)}(?![\\w$])`, "u"); const hits: Site[] = [];
    for (const file of files) {
      if (cited.has(file.path) || !textOf(file).includes(name)) continue;
      file.lines.forEach((line, index) => { if (word.test(line) && definitionOf(line) !== name && !isComment(line)) hits.push({ path: file.path, line: index + 1 }); });
      if (hits.length > MAXIMUM_CALLER_HITS) break;
    }
    const sites = hits.length > MAXIMUM_CALLER_HITS ? [] : hits.sort((a, b) => nearness(b.path, near) - nearness(a.path, near) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    callerCache.set(key, sites);
    return sites;
  };
  const numbered = (file: ContextFile, from: number, to: number) => file.lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join("\n");
  /** A definition from its line to the end of its block, or the next definition at its depth, or the line limit. */
  const definitionLines = (file: ContextFile, line: number): number => {
    const depth = indentOf(file.lines[line - 1] ?? "");
    for (let next = line + 1; next < line + RELATED_SOURCE_LIMITS.definitionLines && next <= file.lines.length; next += 1) {
      const text = file.lines[next - 1] ?? "";
      if (text.trim() !== "" && indentOf(text) <= depth) return /^\s*(?:end|\}|\)|\])[,;]?\s*$/u.test(text) ? next : next - 1;
    }
    return Math.min(file.lines.length, line + RELATED_SOURCE_LIMITS.definitionLines - 1);
  };

  return (locations) => {
    const limits = RELATED_SOURCE_LIMITS;
    const cited = new Set(locations.map(({ path }) => path));
    const places = [...new Map(locations.map((location) => [`${location.path}\0${location.startLine}\0${location.endLine}`, location])).values()].slice(0, limits.locations);
    const first = places[0]?.path ?? "";
    // Names used at the cited lines, most used first.
    const used = new Map<string, number>(); const enclosing: string[] = [];
    for (const { path, startLine, endLine } of places) {
      const file = byPath.get(path); if (file === undefined) continue;
      for (const line of file.lines.slice(Math.max(0, startLine - 1), Math.min(file.lines.length, endLine, startLine + limits.locationLines - 1)))
        for (const match of line.matchAll(/[A-Za-z_$][\w$]*[?!]?/gu)) { const name = match[0]; if (name.length >= MINIMUM_NAME && !COMMON.has(name)) used.set(name, (used.get(name) ?? 0) + 1); }
      for (let index = Math.min(startLine, file.lines.length) - 1; index >= 0; index -= 1) {
        const name = definitionOf(file.lines[index] ?? "");
        if (name !== null) { if (name.length >= MINIMUM_NAME && !COMMON.has(name) && !enclosing.includes(name)) enclosing.push(name); break; }
      }
    }
    const callers: RelatedExcerpt[] = []; const taken = new Set<string>(); let bytes = 0;
    const add = (list: RelatedExcerpt[], excerpt: RelatedExcerpt) => { const size = Buffer.byteLength(excerpt.content); if (bytes + size > limits.bytes) return false; bytes += size; list.push(excerpt); return true; };
    for (const name of enclosing) {
      let perName = 0;
      for (const { path, line } of callersOf(name, cited, first)) {
        if (callers.length >= limits.callers || perName >= limits.callersPerName) break;
        const file = byPath.get(path); if (file === undefined) continue;
        const from = Math.max(1, line - limits.callerContext); const to = Math.min(file.lines.length, line + limits.callerContext);
        if (taken.has(`${path}\0${from}`)) continue;
        if (add(callers, { at: `${path}:${from}-${to}`, why: `calls ${name}, which the cited lines are part of`, content: numbered(file, from, to), trust: "untrusted_data" })) { taken.add(`${path}\0${from}`); perName += 1; }
      }
    }
    const candidates = [...used].flatMap(([name, count]) => {
      const sites = definitionIndex().get(name) ?? [];
      // A name the cited files define themselves is read there; one defined in many places could be any of them.
      if (sites.length === 0 || sites.length > limits.sitesPerName || sites.some(({ path }) => cited.has(path))) return [];
      return [{ name, count, sites }];
    }).sort((a, b) => b.count - a.count || a.sites.length - b.sites.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const defined: RelatedExcerpt[] = []; const seen = new Set<string>();
    for (const { name, sites } of candidates) {
      for (const { path, line } of sites) {
        if (defined.length >= limits.definitions) break;
        const file = byPath.get(path); if (file === undefined || seen.has(`${path}\0${line}`)) continue;
        const to = definitionLines(file, line);
        if (add(defined, { at: `${path}:${line}-${to}`, why: `defines ${name}, used at the cited lines`, content: numbered(file, line, to), trust: "untrusted_data" })) seen.add(`${path}\0${line}`);
      }
      if (defined.length >= limits.definitions) break;
    }
    return defined.length === 0 && callers.length === 0 ? null : Object.freeze({ note: NOTE, definitions: Object.freeze(defined), callers: Object.freeze(callers) });
  };
}
