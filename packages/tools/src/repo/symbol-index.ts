/**
 * Definitions and references of every name in a snapshot, from line patterns alone: pure JavaScript, no parser or native
 * module, so it runs in the single-file app, and the same text gives the same answer. A pattern can miss a definition or
 * end a body early; the model still has the literal search and the file reads, and what it is shown is always exact lines.
 * Observed (nananananana, November 1, 2026): 951 of 1,510 discovery searches were a bare name, with a read to follow.
 */
export interface SourceLines { readonly path: string; readonly lines: readonly string[] }
export interface SymbolDefinition {
  readonly path: string; readonly startLine: number; readonly endLine: number;
  /** The body runs on past `endLine`: it did not end within MAXIMUM_BODY_LINES. */
  readonly cut: boolean;
}
export interface SymbolReference { readonly path: string; readonly line: number }
export interface SymbolIndex {
  definitions(name: string): readonly SymbolDefinition[];
  references(name: string): readonly SymbolReference[];
  linesOf(path: string): readonly string[] | undefined;
}

export const MAXIMUM_BODY_LINES = 200;
/** Declarations start a line, so only its head is matched. */
const LINE_HEAD = 240;
/** A longer line is minified or data: no reference is taken from it. */
const MAXIMUM_TOKENIZED_LINE = 2_000;

type BodyShape = "braces" | "indentation" | "end";
interface Family { readonly extensions: readonly string[]; readonly shape: BodyShape; readonly suffixedNames?: true; readonly names: (head: string) => readonly string[] }

const KEYWORDS = new Set(["if", "else", "for", "while", "switch", "case", "catch", "return", "function", "new", "throw", "do", "try", "await", "yield", "typeof", "sizeof", "delete", "assert", "super", "this", "with", "using", "lock", "foreach", "elif", "except", "match"]);
const first = (pattern: RegExp) => (head: string): readonly string[] => { const name = pattern.exec(head)?.[1]; return name === undefined ? [] : [name]; };
const anyOf = (...extractors: readonly ((head: string) => readonly string[])[]) => (head: string): readonly string[] => {
  for (const extract of extractors) { const names = extract(head); if (names.length > 0) return names; }
  return [];
};
const notKeyword = (extract: (head: string) => readonly string[]) => (head: string) => extract(head).filter((name) => !KEYWORDS.has(name));

const JS_MODIFIERS = "(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?";
const JS = anyOf(
  first(new RegExp(`^\\s*${JS_MODIFIERS}(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)`, "u")),
  first(new RegExp(`^\\s*${JS_MODIFIERS}(?:const\\s+)?(?:class|interface|type|enum|namespace)\\s+([A-Za-z_$][\\w$]*)`, "u")),
  first(/^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/u),
  // A class member or an object's function: the name, then parameters that open a body, or an arrow function's value.
  notKeyword(first(/^\s+(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::[^{;]*)?\{\s*$/u)),
  first(/^\s+(?:(?:public|private|protected|static|readonly|override)\s+)*([A-Za-z_$#][\w$]*)\s*(?::[^=]*?)?[:=]\s*(?:async\s+)?(?:\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>|function\b)/u),
);
const ELIXIR_MODULE = (head: string): readonly string[] => {
  const name = /^\s*(?:defmodule|defprotocol)\s+([A-Z][\w.]*)/u.exec(head)?.[1];
  return name === undefined ? [] : [...new Set([name, name.split(".").at(-1) ?? name])];
};
const ELIXIR = anyOf(ELIXIR_MODULE, first(/^\s*(?:def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate|defimpl|defoverridable)\s+([A-Za-z_][\w]*[?!]?)/u), first(/^\s*@(?:type|typep|opaque|callback)\s+([A-Za-z_][\w]*[?!]?)/u));
const RUBY = anyOf(first(/^\s*(?:class|module)\s+(?:[\w:]+::)?([A-Z]\w*)/u), first(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/u));
const GO = anyOf(first(/^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/u), first(/^func\s+([A-Za-z_]\w*)/u), first(/^type\s+([A-Za-z_]\w*)/u), first(/^(?:var|const)\s+([A-Za-z_]\w*)/u));
const PYTHON = anyOf(first(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/u), first(/^\s*class\s+([A-Za-z_]\w*)/u), first(/^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/u));
const RUST = anyOf(
  first(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/u),
  first(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:struct|enum|trait|type|const|static|mod|union)\s+(?:mut\s+)?([A-Za-z_]\w*)/u),
  first(/^\s*macro_rules!\s+([A-Za-z_]\w*)/u),
);
const OBJECT_MODIFIERS = "(?:(?:public|private|protected|internal|abstract|final|sealed|static|open|data|inline|value|partial|override|export|annotation|readonly|external|factory|async|suspend|virtual|synchronized|const|late)\\s+)*";
const OBJECT_TYPES = first(new RegExp(`^\\s*${OBJECT_MODIFIERS}(?:class|interface|enum|record|object|struct|trait|protocol|extension|mixin|typedef|namespace|@interface)\\s+([A-Za-z_]\\w*)`, "u"));
const OBJECT_KEYWORD_FUNCTIONS = first(new RegExp(`^\\s*${OBJECT_MODIFIERS}(?:fun|func|function|def)\\s+(?:<[^>]*>\\s*)?(?:[A-Za-z_][\\w.]*\\.)?([A-Za-z_]\\w*)`, "u"));
// A return type, the name, its parameters, and a body or nothing yet: `return load(1);` ends a statement, a declaration does not.
const OBJECT_METHODS = notKeyword(first(new RegExp(`^\\s*${OBJECT_MODIFIERS}(?!return\\b|new\\b|throw\\b|else\\b|await\\b)[A-Za-z_][\\w.<>\\[\\],?& ]*[\\s>\\]?]([A-Za-z_]\\w*)\\s*(?:<[^>]*>\\s*)?\\([^;]*\\)\\s*(?:throws\\s+[\\w., ]+|async\\*?|const)?\\s*(?:\\{\\s*|=>.*)?$`, "u")));
const OBJECT = anyOf(OBJECT_TYPES, OBJECT_KEYWORD_FUNCTIONS, OBJECT_METHODS);
const C_TYPES = first(/^\s*(?:typedef\s+)?(?:template\s*<[^>]*>\s*)?(?:struct|class|union|enum(?:\s+class)?|namespace)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/u);
const C_MACRO = first(/^\s*#\s*define\s+([A-Za-z_]\w*)/u);
/** A definition starting a line: a type, then the name before its parameters, on a line that does not end a statement. */
const C_FUNCTION = (head: string): readonly string[] => {
  if (!/^(?:\s{2,}|\t)?[A-Za-z_~]/u.test(head) || head.trimEnd().endsWith(";")) return [];
  const open = head.indexOf("(");
  if (open < 1) return [];
  const before = head.slice(0, open).trimEnd();
  let start = before.length;
  while (start > 0 && /[\w~]/u.test(before[start - 1] ?? "")) start -= 1;
  const name = before.slice(start);
  // A name with nothing before it is a call or a macro, not a definition.
  return name === "" || before.slice(0, start).trim() === "" || KEYWORDS.has(name) || KEYWORDS.has(before.slice(0, start).trim()) || !/^[A-Za-z_~]/u.test(name) ? [] : [name];
};
const C = anyOf(C_MACRO, C_TYPES, C_FUNCTION);

const FAMILIES: readonly Family[] = [
  { extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro"], shape: "braces", names: JS },
  { extensions: [".ex", ".exs"], shape: "end", suffixedNames: true, names: ELIXIR },
  { extensions: [".rb"], shape: "end", suffixedNames: true, names: RUBY },
  { extensions: [".go"], shape: "braces", names: GO },
  { extensions: [".py"], shape: "indentation", names: PYTHON },
  { extensions: [".rs"], shape: "braces", names: RUST },
  { extensions: [".java", ".dart", ".kt", ".kts", ".scala", ".groovy", ".cs", ".swift", ".php"], shape: "braces", names: OBJECT },
  { extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm"], shape: "braces", names: C },
];

function familyOf(path: string): Family | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || path.indexOf("/", dot) >= 0) return undefined;
  const extension = path.slice(dot).toLowerCase();
  return FAMILIES.find(({ extensions }) => extensions.includes(extension));
}

/** Where a body delimited by brackets ends: the line its brackets balance, or the line a statement without any ends. */
function bracesEnd(lines: readonly string[], start: number): { end: number; cut: boolean } {
  let depth = 0; let opened = false; let inBlockComment = false; let inTemplate = false;
  const limit = Math.min(lines.length, start + MAXIMUM_BODY_LINES);
  for (let index = start; index < limit; index += 1) {
    const line = lines[index] ?? "";
    let quote: string | null = null;
    for (let at = 0; at < line.length; at += 1) {
      const character = line[at];
      if (inBlockComment) { if (character === "*" && line[at + 1] === "/") { inBlockComment = false; at += 1; } continue; }
      if (inTemplate) { if (character === "\\") at += 1; else if (character === "`") inTemplate = false; continue; }
      if (quote !== null) { if (character === "\\") at += 1; else if (character === quote) quote = null; continue; }
      if (character === "/" && line[at + 1] === "/") break;
      if (character === "/" && line[at + 1] === "*") { inBlockComment = true; at += 1; continue; }
      if (character === "`") { inTemplate = true; continue; }
      if (character === "\"" || character === "'") { quote = character; continue; }
      if (character === "{" || character === "(" || character === "[") { depth += 1; opened = true; }
      else if (character === "}" || character === ")" || character === "]") depth -= 1;
    }
    if (inBlockComment || inTemplate) continue;
    const trimmed = line.trimEnd();
    if (depth <= 0 && opened) {
      // A signature's parameters close before its body opens: `int load(int a)` followed by `{`, or `(a): T =>`.
      const next = (lines[index + 1] ?? "").trim();
      if (depth === 0 && !trimmed.endsWith(";") && !trimmed.endsWith("}") && (next.startsWith("{") || /(?:=>|=|,|:|\|\|?|&&?)$/u.test(trimmed))) continue;
      if (depth === 0 && /\)\s*(?::[^{;]*)?$/u.test(trimmed) && next.startsWith("{")) continue;
      return { end: index, cut: false };
    }
    if (depth <= 0 && !opened && !/(?:=|=>|,|\||&|\+|:|<)$/u.test(trimmed)) {
      // A declaration with no brackets on its line: its body may open on the next line, or it ends here.
      if ((lines[index + 1] ?? "").trim().startsWith("{")) continue;
      return { end: index, cut: false };
    }
  }
  return { end: limit - 1, cut: limit < lines.length };
}

const indentOf = (line: string): number => /^[ \t]*/u.exec(line)?.[0].length ?? 0;

/** Where an indented body ends: the last line before one no deeper than its first, once its signature closed. */
function indentationEnd(lines: readonly string[], start: number): { end: number; cut: boolean } {
  const own = indentOf(lines[start] ?? "");
  let open = 0; let index = start;
  const limit = Math.min(lines.length, start + MAXIMUM_BODY_LINES);
  // The signature may run over several lines, at any indentation.
  for (; index < limit; index += 1) {
    const line = lines[index] ?? "";
    for (const character of line) { if (character === "(" || character === "[" || character === "{") open += 1; else if (character === ")" || character === "]" || character === "}") open -= 1; }
    if (open <= 0) break;
  }
  let last = Math.min(index, limit - 1);
  for (let next = index + 1; next < limit; next += 1) {
    const line = lines[next] ?? "";
    if (line.trim() === "") continue;
    if (indentOf(line) <= own) return { end: last, cut: false };
    last = next;
  }
  return { end: last, cut: limit < lines.length };
}

/** Where a `do`/`end` body ends: the `end` at its first line's indentation, or the line of a one-line form. */
function endKeywordEnd(lines: readonly string[], start: number): { end: number; cut: boolean } {
  const own = indentOf(lines[start] ?? "");
  const limit = Math.min(lines.length, start + MAXIMUM_BODY_LINES);
  const head = lines[start] ?? "";
  if (/,\s*do:/u.test(head) || /^\s*(?:@|defoverridable|defdelegate\b)/u.test(head)) return { end: start, cut: false };
  // The head may run over several lines before its `do`; one that never opens a block is a single statement.
  let opened = -1;
  for (let index = start; index < limit; index += 1) {
    const line = lines[index] ?? "";
    if (/\bdo\s*(?:\|[^|]*\|)?\s*$/u.test(line) || /^\s*(?:class|module|def)\b/u.test(line) && index === start && !/,\s*$/u.test(line) && !/\($/u.test(line)) { opened = index; break; }
    if (/,\s*do:/u.test(line)) return { end: index, cut: false };
    if (index > start && indentOf(line) <= own && line.trim() !== "") break;
  }
  if (opened < 0) return { end: start, cut: false };
  for (let index = opened + 1; index < limit; index += 1) {
    const line = lines[index] ?? "";
    if (indentOf(line) === own && /^\s*end\b/u.test(line)) return { end: index, cut: false };
  }
  return { end: limit - 1, cut: limit < lines.length };
}

const END_OF: Readonly<Record<BodyShape, (lines: readonly string[], start: number) => { end: number; cut: boolean }>> = { braces: bracesEnd, indentation: indentationEnd, end: endKeywordEnd };

/** Every identifier of a line, once. `suffixed`: in Elixir and Ruby a trailing `?` or `!` is part of the name. */
function tokensOf(line: string, suffixed: boolean): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const [token] of line.matchAll(suffixed ? /[\p{L}_][\p{L}\p{N}_]*(?:[?!](?!=))?/gu : /[\p{L}_$][\p{L}\p{N}_$]*/gu)) tokens.add(token);
  return tokens;
}

/** One file index and line in one number, so the map of a large repository stays small. */
const LINE_RANGE = 2 ** 24;

/** Built once from a snapshot's files; the order they arrive in changes nothing. */
export function buildSymbolIndex(files: readonly SourceLines[]): SymbolIndex {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const definitionLines = new Map<string, number[]>();
  const referenceLines = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, value: number) => { const list = map.get(key); if (list === undefined) map.set(key, [value]); else list.push(value); };
  for (const [fileIndex, { path, lines }] of sorted.entries()) {
    const family = familyOf(path);
    for (const [index, line] of lines.entries()) {
      const packed = fileIndex * LINE_RANGE + index;
      if (family !== undefined) for (const name of family.names(line.slice(0, LINE_HEAD))) add(definitionLines, name, packed);
      if (line.length > MAXIMUM_TOKENIZED_LINE) continue;
      for (const token of tokensOf(line, family?.suffixedNames === true)) add(referenceLines, token, packed);
    }
  }
  const unpack = (packed: number) => { const file = sorted[Math.floor(packed / LINE_RANGE)]; return { file, line: packed % LINE_RANGE }; };
  const byPath = new Map(sorted.map((file) => [file.path, file.lines]));
  return {
    linesOf: (path) => byPath.get(path),
    definitions(name) {
      return (definitionLines.get(name) ?? []).flatMap((packed): SymbolDefinition[] => {
        const { file, line } = unpack(packed);
        const family = file === undefined ? undefined : familyOf(file.path);
        if (file === undefined || family === undefined) return [];
        const { end, cut } = END_OF[family.shape](file.lines, line);
        return [{ path: file.path, startLine: line + 1, endLine: Math.max(end, line) + 1, cut }];
      });
    },
    references(name) {
      const own = new Set(definitionLines.get(name) ?? []);
      return (referenceLines.get(name) ?? []).filter((packed) => !own.has(packed)).flatMap((packed): SymbolReference[] => {
        const { file, line } = unpack(packed);
        return file === undefined ? [] : [{ path: file.path, line: line + 1 }];
      });
    },
  };
}

const DECLARATION_WORDS = /^(?:export|default|declare|async|function|def|defp|defmacro|class|interface|type|enum|struct|const|let|var|fn|func|pub|public|private|protected|static)$/u;

/** The name in what a model asks for: `setUser(`, `queryClient.clear`, `Posts.get_post/2`, `def show`. Null when it holds none. */
export function symbolName(raw: string): string | null {
  const bare = raw.trim().replace(/\(.*$/su, "").replace(/\/\d+$/u, "").trim();
  const word = bare.split(/\s+/u).filter((part) => !DECLARATION_WORDS.test(part)).at(-1) ?? "";
  const last = word.split(/\.|::|#|->/u).at(-1) ?? "";
  return /^[\p{L}_$][\p{L}\p{N}_$]*[?!]?$/u.test(last) ? last : null;
}
