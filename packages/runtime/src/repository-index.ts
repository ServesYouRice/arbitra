import { posix } from "node:path";
import type { RepositorySnapshot } from "./repository.js";

/**
 * A compact map of the whole repository that every discovery unit carries: each file with its line count and its
 * exported or top-level symbols, grouped by directory. A unit audits its own files, and with the map it can see what
 * lies outside them and read it through the snapshot tools. Observed live (nextra, October 23, 2026): 52 limitations
 * said a caller was "not supplied", and 8 of 97 discovery calls used a tool.
 *
 * The map is the same for every unit of a run, so it goes before the unit's files, where it stays in the prompt's
 * cached prefix. It is kept within `maximumBytes`: every file and its line count first, then symbols while they fit,
 * and when even the files do not fit, the first that do and how many were left out.
 */
export interface RepositoryIndex {
  readonly format: string;
  readonly directories: Readonly<Record<string, readonly string[]>>;
  readonly omittedFiles?: number;
}

/**
 * The index's largest size, in bytes of JSON. Measured October 25, 2026: nextra (173 files, 613 symbols) takes 12,900
 * bytes whole; veritra (427 files, 2,515 symbols) takes 53,000 whole, 12,800 as files and line counts alone, and at
 * this cap lists every file and the first symbol of 193. nextra's units were sized at 100,000 to 256,000 estimated
 * tokens, output allowance included, so the index takes up to a sixth of a unit, and is the same text in every unit.
 */
export const REPOSITORY_INDEX_MAXIMUM_BYTES = 16_384;
const MAXIMUM_SYMBOLS_PER_FILE = 12;
const MAXIMUM_SYMBOL_LENGTH = 48;
/** Declarations start a line, so only its head is searched: a minified line can be half a megabyte. */
const LINE_HEAD = 240;
const FORMAT = "Every file of the repository, by directory, as \"name lines: symbols\": its line count, then its exported or top-level declarations (+N counts those left out). Read any of them with the source tools.";

/**
 * Every file with its line count first; then symbols are added a rank at a time (each file's first, then each file's
 * second, up to twelve) while they fit. When even the files do not fit, the first that do are listed, in path order.
 */
export function repositoryIndex(snapshot: RepositorySnapshot, maximumBytes = REPOSITORY_INDEX_MAXIMUM_BYTES): RepositoryIndex | null {
  // By directory, the repository's top first, so each directory's files sit together.
  const key = (path: string) => `${posix.dirname(path) === "." ? "" : posix.dirname(path)}\0${posix.basename(path)}`;
  const files = [...snapshot.files].sort((a, b) => key(a.path) < key(b.path) ? -1 : key(a.path) > key(b.path) ? 1 : 0).map(({ path, lines }) => ({ path, lineCount: lines.length, symbols: symbolsOf(path, lines).slice(0, 64) }));
  const entry = (index: number, shown: number): string => {
    const file = files[index];
    if (file === undefined) return "";
    const names = file.symbols.slice(0, shown); const rest = file.symbols.length - names.length;
    return `${posix.basename(file.path)} ${file.lineCount}${names.length === 0 ? "" : `: ${names.join(", ")}${rest === 0 ? "" : `, +${rest}`}`}`;
  };
  const shown = files.map(() => 0);
  const build = (count = files.length): RepositoryIndex => {
    const directories: Record<string, string[]> = {};
    for (let index = 0; index < count; index += 1) (directories[posix.dirname(files[index]?.path ?? "")] ??= []).push(entry(index, shown[index] ?? 0));
    return { format: FORMAT, directories, ...(count < files.length ? { omittedFiles: files.length - count } : {}) };
  };
  const size = (index: RepositoryIndex) => Buffer.byteLength(JSON.stringify(index));
  let total = size(build());
  if (total > maximumBytes) {
    let low = 0; let high = files.length - 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (size(build(middle)) <= maximumBytes) low = middle; else high = middle - 1; }
    return low === 0 ? null : build(low);
  }
  const bytes = (text: string) => Buffer.byteLength(JSON.stringify(text));
  for (let rank = 1; rank <= MAXIMUM_SYMBOLS_PER_FILE; rank += 1) {
    for (const [index, file] of files.entries()) {
      if (file.symbols.length < rank) continue;
      const added = bytes(entry(index, rank)) - bytes(entry(index, rank - 1));
      if (total + added > maximumBytes) return build();
      shown[index] = rank; total += added;
    }
  }
  return build();
}

/** The artifact, one an auditor, holding the index its discovery units were sent (`{ json }`, "null" when none fit). */
export const REPOSITORY_INDEX_KIND_PREFIX = "discovery-index-";

type Extractor = (head: string) => readonly string[];

const JS_EXPORT = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*\s*|function\s+|class\s+|interface\s+|type\s+|enum\s+|const\s+enum\s+|const\s+|let\s+|var\s+|namespace\s+)([A-Za-z_$][\w$]*)/u;
const JS_EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/u;
const JS_EXPORT_NAMESPACE = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)/u;
const JS_COMMONJS = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/u;
// A module a file requires is not one of its own declarations.
const JS_TOP = /^(?:async\s+)?function(?:\s*\*\s*|\s+)([A-Za-z_$][\w$]*)|^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!\s*(?:require\s*\(|await\s+import\s*\())/u;
const JS_MODULE_EXPORTS = /^module\.exports\s*=\s*(?:(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*;?\s*$|(\{))/u;
const JS_KEY = /^\s*(?:async\s+)?\*?\s*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:[,:(}]|$)/u;

/** The names of an object literal that opens on `lines[start]` after `{` and closes on a line starting with `}`. */
function objectKeys(lines: readonly string[], start: number, rest: string): readonly string[] {
  const keys: string[] = [];
  const take = (text: string) => { for (const part of text.split(",")) { const name = JS_KEY.exec(part)?.[1]; if (name !== undefined) keys.push(name); } };
  const close = rest.indexOf("}");
  if (close >= 0) { take(rest.slice(0, close)); return keys; }
  take(rest);
  // Only the object's own keys, at the indentation of its first: not the bodies of the methods it defines.
  let indentation: string | undefined;
  for (let index = start + 1; index < lines.length && index <= start + 400; index += 1) {
    const line = (lines[index] ?? "").slice(0, LINE_HEAD);
    if (line.startsWith("}")) break;
    if (line.trim() === "") continue;
    const own = /^[ \t]*/u.exec(line)?.[0] ?? "";
    indentation ??= own;
    if (own !== indentation) continue;
    const name = JS_KEY.exec(line)?.[1];
    if (name !== undefined) keys.push(name);
  }
  return keys;
}

/** Exported names when the file exports any, else its top-level declarations (a script, an entry point). */
function javascript(lines: readonly string[]): readonly string[] {
  const exported: string[] = []; const top: string[] = [];
  for (const [index, line] of lines.entries()) {
    const head = line.slice(0, LINE_HEAD);
    if (!head.startsWith("export") && !head.startsWith("module.") && !head.startsWith("exports.")) {
      const match = JS_TOP.exec(head);
      const name = match?.[1] ?? match?.[2] ?? match?.[3];
      if (name !== undefined) top.push(name);
      continue;
    }
    const declared = JS_EXPORT.exec(head)?.[1];
    if (declared !== undefined) { exported.push(declared); continue; }
    const list = JS_EXPORT_LIST.exec(head)?.[1];
    if (list !== undefined) { exported.push(...list.split(",").map((item) => item.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u).at(-1)?.trim() ?? "").filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name))); continue; }
    const namespace = JS_EXPORT_NAMESPACE.exec(head)?.[1] ?? JS_COMMONJS.exec(head)?.[1];
    if (namespace !== undefined) { exported.push(namespace); continue; }
    const commonjs = JS_MODULE_EXPORTS.exec(head);
    if (commonjs !== null) {
      const named = commonjs[1] ?? commonjs[2] ?? commonjs[3];
      const keys = named === undefined && commonjs[4] !== undefined ? objectKeys(lines, index, head.slice(head.indexOf("{") + 1)) : [];
      exported.push(...(named !== undefined ? [named] : keys.length > 0 ? keys : ["module.exports"]));
      continue;
    }
    if (/^export\s+default\b/u.test(head)) exported.push("default");
    else if (/^module\.exports\s*=/u.test(head)) exported.push("module.exports");
  }
  return exported.length > 0 ? exported : top;
}

/** Public names first: a name with a leading underscore (Python) or a lower-case one (Go) is listed after them. */
function publicFirst(names: readonly string[], isPublic: (name: string) => boolean): readonly string[] {
  return [...names.filter(isPublic), ...names.filter((name) => !isPublic(name))];
}

function byPatterns(...patterns: readonly RegExp[]): Extractor {
  return (head) => {
    for (const pattern of patterns) {
      const match = pattern.exec(head);
      if (match === null) continue;
      const groups = match.slice(1).filter((group): group is string => group !== undefined);
      return groups.length === 0 ? [] : [groups.join(".")];
    }
    return [];
  };
}

const PYTHON = byPatterns(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/u, /^class\s+([A-Za-z_]\w*)/u);
const GO = byPatterns(/^func\s+\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*([A-Za-z_]\w*)/u, /^func\s+([A-Za-z_]\w*)/u, /^type\s+([A-Za-z_]\w*)/u, /^(?:var|const)\s+([A-Za-z_]\w*)/u);
const RUST_PUBLIC = /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static|mod|union|macro)\s+([A-Za-z_]\w*)/u;
const RUST_PRIVATE = /^(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static|mod|union)\s+([A-Za-z_]\w*)/u;
const TYPE_DECLARATION = /^(?:(?:public|private|protected|internal|abstract|final|sealed|static|open|data|inline|value|partial|export|annotation|case|readonly)\s+)*(?:class|interface|enum|record|object|struct|trait|protocol|extension|mixin|fun|func|function|def|module|namespace)\s+([A-Za-z_]\w*)/u;
const RUBY = byPatterns(/^(?:class|module)\s+([A-Z][\w:]*)/u, /^def\s+(?:self\.)?([\w?!=]+)/u);
const SHELL = byPatterns(/^function\s+([A-Za-z_][\w-]*)/iu, /^([A-Za-z_][\w-]*)\s*\(\)/u);
const SQL = byPatterns(/^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:table|view|materialized\s+view|function|procedure|unique\s+index|index|trigger|type|schema)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/iu);
const SCHEMA_LANGUAGE = byPatterns(/^(?:extend\s+)?(?:type|input|enum|interface|union|scalar|message|service|model|schema|datasource|generator)\s+(\w+)/u);
const TERRAFORM = byPatterns(/^(?:resource|data)\s+"([^"]+)"\s+"([^"]+)"/u, /^(?:module|variable|output|provider)\s+"([^"]+)"/u);
const OTHER = byPatterns(/^(?:local\s+)?function\s+([\w.:]+)/u, /^sub\s+(\w+)/u, /^package\s+([\w:]+)\s*;/u, /^(?:abstract\s+)?(?:contract|library)\s+(\w+)/u, /^pub\s+(?:fn|const|var)\s+(\w+)/u,
  /^defmodule\s+([\w.]+)/u, /^(?:function|struct|module|macro)\s+(\w+)/u, /^\(defn-?\s+([\w\-!?*<>]+)/u, /^let\s+(?:rec\s+)?(\w+)/u, /^([A-Za-z_.][\w.]*)\s*(?:<-|=)\s*function/u);

const C_KEYWORDS = new Set(["if", "for", "while", "switch", "return", "else", "do", "sizeof", "case", "static_assert", "defined"]);
/** A definition starting a line: a type, then the name before its parameters, on a line that does not end a statement. */
function cFamily(head: string): readonly string[] {
  const type = /^(?:typedef\s+)?(?:struct|class|union|enum)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/u.exec(head)?.[1];
  if (type !== undefined) return [type];
  if (!/^[A-Za-z_]/u.test(head) || head.trimEnd().endsWith(";")) return [];
  const open = head.indexOf("(");
  if (open < 1) return [];
  const before = head.slice(0, open).trimEnd();
  let start = before.length;
  while (start > 0 && /[\w:~]/u.test(before[start - 1] ?? "")) start -= 1;
  const name = before.slice(start);
  // A name with nothing before it is a call or a macro (`MODULE_LICENSE("GPL")`), not a definition.
  return name === "" || start === 0 || C_KEYWORDS.has(name) || !/^[A-Za-z_~]/u.test(name) ? [] : [name];
}

const EXTRACTORS: readonly { readonly extensions: readonly string[]; readonly lines: (lines: readonly string[]) => readonly string[] }[] = [
  { extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro"], lines: javascript },
  { extensions: [".py"], lines: (lines) => publicFirst(each(lines, PYTHON), (name) => !name.startsWith("_")) },
  { extensions: [".go"], lines: (lines) => publicFirst(each(lines, GO), (name) => /^[A-Z]/u.test(name.split(".").at(-1) ?? "")) },
  { extensions: [".rs"], lines: (lines) => { const pub = each(lines, byPatterns(RUST_PUBLIC)); return pub.length > 0 ? pub : each(lines, byPatterns(RUST_PRIVATE)); } },
  // A C# namespace block indents its types by one level.
  { extensions: [".cs"], lines: (lines) => each(lines, (head) => byPatterns(TYPE_DECLARATION)(head.replace(/^ {1,4}(?=\S)|^\t(?=\S)/u, ""))) },
  { extensions: [".java", ".kt", ".scala", ".groovy", ".fs", ".php", ".swift", ".dart"], lines: (lines) => each(lines, byPatterns(TYPE_DECLARATION)) },
  { extensions: [".rb"], lines: (lines) => each(lines, RUBY) },
  { extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm"], lines: (lines) => each(lines, cFamily) },
  { extensions: [".sh", ".bash", ".ps1", ".psm1"], lines: (lines) => each(lines, SHELL) },
  { extensions: [".sql"], lines: (lines) => each(lines, SQL) },
  { extensions: [".graphql", ".gql", ".proto", ".prisma"], lines: (lines) => each(lines, SCHEMA_LANGUAGE) },
  { extensions: [".tf"], lines: (lines) => each(lines, TERRAFORM) },
  { extensions: [".lua", ".pl", ".pm", ".sol", ".zig", ".ex", ".exs", ".jl", ".clj", ".cljs", ".ml", ".r"], lines: (lines) => each(lines, OTHER) },
];

function each(lines: readonly string[], extract: Extractor): readonly string[] {
  return lines.flatMap((line) => extract(line.slice(0, LINE_HEAD)));
}

/** A file's exported or top-level symbols, in source order, each once. Markup, styles and manifests have none. */
export function symbolsOf(path: string, lines: readonly string[]): readonly string[] {
  const extension = posix.extname(path).toLowerCase();
  const extractor = EXTRACTORS.find(({ extensions }) => extensions.includes(extension));
  if (extractor === undefined) return [];
  return [...new Set(extractor.lines(lines).map((name) => name.length > MAXIMUM_SYMBOL_LENGTH ? `${name.slice(0, MAXIMUM_SYMBOL_LENGTH - 1)}…` : name))];
}
