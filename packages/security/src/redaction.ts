export const REDACTION_PATTERN_VERSION = "5" as const;

export type SecretKind =
  | "aws_access_key"
  | "api_token"
  | "github_token"
  | "bearer_token"
  | "assigned_secret"
  | "private_key";

export interface SecretRedaction {
  readonly kind: SecretKind;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly redactions: readonly SecretRedaction[];
  readonly patternVersion: typeof REDACTION_PATTERN_VERSION;
}

interface Detector {
  readonly kind: SecretKind;
  readonly expression: RegExp;
  readonly secretGroup: number;
}

/** The word a name that holds a secret ends in. */
const SECRET_WORD = "(?:api[_-]?key|secret(?:[_-]?access)?[_-]?key|secret|passw(?:or)?d|passphrase|token)";
/** A name that holds a secret, with any prefix: `password`, `DB_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, `clientSecret`. */
const SECRET_FIELD = new RegExp(`^[A-Za-z0-9_-]*?${SECRET_WORD}$`, "iu");
const NAME_CHARACTER = /[A-Za-z0-9_-]/iu;
const WORD_BOUNDARY = /\b/giu;
/**
 * Where the name that ends in the word at `word` starts, as `\b[A-Za-z0-9_-]*?` tried from `from` on finds it: at the
 * first word boundary after which only a name's characters lead to the word, or -1. The flags are the pattern's, so
 * the class and `\b` read every character as the pattern did.
 */
function nameStart(text: string, word: number, from: number): number {
  let start = word;
  while (start > from && NAME_CHARACTER.test(text.charAt(start - 1))) start -= 1;
  WORD_BOUNDARY.lastIndex = start;
  const boundary = WORD_BOUNDARY.exec(text)?.index ?? -1;
  return boundary <= word ? boundary : -1;
}

const DETECTORS: readonly Detector[] = [
  { kind: "aws_access_key", expression: /\b(AKIA[0-9A-Z]{16})\b/gud, secretGroup: 1 },
  { kind: "api_token", expression: /\b(sk-[A-Za-z0-9_-]{12,255})\b/gud, secretGroup: 1 },
  { kind: "github_token", expression: /\b((?:gh[opusr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}))\b/gud, secretGroup: 1 },
  { kind: "bearer_token", expression: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/giud, secretGroup: 1 },
  {
    kind: "assigned_secret",
    // The value never ends in a backslash: inside JSON text that backslash escapes the quote after it. Observed
    // live (P20 pilot): a redaction marker followed by an escaped quote was taken for a secret again, the escape
    // was lost with it, and the stored artifact no longer parsed.
    // A name may carry a prefix (DB_PASSWORD, AWS_SECRET_ACCESS_KEY, clientSecret): `\b` alone fails inside a name
    // joined by "_", which is a word character (found by arbitra's audit of itself, October 19, 2026).
    // The pattern finds the word a name ends in, and the name's start is sought back from it: a lazy prefix tried
    // from every word boundary scanned a long run of a name's characters once per boundary, and 100 KB of `a-a-a-…`
    // took 3.5 s to mask, 1 MB 449 s (found October 25, 2026).
    // A quote may be escaped: a prompt carries whole files as JSON strings, in which `password = "..."` reads
    // `password = \"...\"`, and such a secret reached the model unmasked (found October 25, 2026).
    // The pattern takes at most 256 characters of a value, so a value scanned again from its start costs a bounded
    // amount; a longer value that is masked is masked to its end.
    expression: new RegExp(`${SECRET_WORD}(?:\\\\*["'])?\\s*[:=]\\s*(?:\\\\*["'])?([^\\s"']{11,255}[^\\s"'\\\\])["']?`, "giud"),
    secretGroup: 1,
  },
  {
    kind: "private_key",
    expression: /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/gud,
    secretGroup: 1,
  },
];

/**
 * An unquoted value that reads as code: a dotted name or a call, without a digit, such as `this.ids.leaseToken(),`
 * or `env.ADMIN_TOKEN`. It names where a secret comes from, not the secret. Observed live (P20 pilot): masking such
 * lines hid how a project generated its lease tokens, and the auditors wrote that they could not audit them. A
 * quoted value, a bare word and anything with a digit are still masked, so the rule errs toward masking.
 *
 * A call or an index on such a name reads as code whatever its arguments hold: `secrets.token_urlsafe(32)`,
 * `client.get("/safety/capability")` (the value is cut at its first quote, so it ends in the open parenthesis) and
 * `request.headers[TOKEN_HEADER]`. Only the name before the call is held to the no-digit rule. Observed live
 * (rokbot, October 24, 2026): masking such lines hid how a project generated and compared its capability token.
 */
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*(?:\([^()]*\))?[,;)\]}]*$/u;
const CODE_CALL = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*[([]/u;
/** `whole` is false for a value longer than the pattern takes, which reads as code only by its call or index. */
function readsAsCode(secret: string, before: string, whole: boolean): boolean {
  if (/["']$/u.test(before)) return false;
  const call = CODE_CALL.exec(secret);
  if (call !== null && !/[0-9]/u.test(call[0])) return true;
  return whole && !/[0-9]/u.test(secret) && CODE_REFERENCE.test(secret) && /[.(]/u.test(secret);
}

/*
 * Where an assigned value ends. The pattern takes every character up to a space or a quote, so in JSON text a value
 * ran on over an escaped line break into the next line, and anywhere it took the delimiters after it. Found by
 * arbitra's audit of itself (October 19, 2026): masked values merged two source lines and took a statement's
 * semicolon, and the auditors reported a syntax error the source does not have. A value ends before an escaped line
 * break or tab, in a query string before the next `&` or `#`, and without a trailing `;`, `,` or a closing bracket
 * it does not open. A cut that would leave fewer than 12 characters, too few to be taken for a secret, or a value
 * ending in a backslash, is not made, so the rule still errs toward masking.
 */
const MINIMUM_SECRET = 12;
function cutAt(value: string, inQuery: boolean): number {
  for (const { index } of value.matchAll(inQuery ? /(?<!\\)\\+[nrt]|[&#]/gu : /(?<!\\)\\+[nrt]/gu)) if (index >= MINIMUM_SECRET && value[index - 1] !== "\\") return index;
  return value.length;
}
/** At the end of a value the pattern took, whether the value goes on: the pattern stopped at its limit. */
const GOES_ON = /\\*[^\s"'\\]/uy;
const VALUE_END = /[\s"']|(?<!\\)\\+[nrt]/gu;
const VALUE_END_IN_QUERY = /[\s"'&#]|(?<!\\)\\+[nrt]/gu;
/** The rest of a value longer than the pattern takes, without the backslashes it ends in. */
function runOn(text: string, from: number, inQuery: boolean): string {
  const pattern = inQuery ? VALUE_END_IN_QUERY : VALUE_END;
  pattern.lastIndex = from;
  let end = pattern.exec(text)?.index ?? text.length;
  while (end > from && text[end - 1] === "\\") end -= 1;
  return text.slice(from, end);
}
function withoutTrailingDelimiters(value: string): string {
  const unopened = new Map(([[")", "("], ["]", "["], ["}", "{"]] as const).map(([close, open]) => [close as string, value.split(close).length - value.split(open).length]));
  let end = value.length;
  while (end > MINIMUM_SECRET && value[end - 2] !== "\\") {
    const last = value.charAt(end - 1);
    const excess = unopened.get(last) ?? 0;
    if (last !== ";" && last !== "," && excess <= 0) break;
    if (excess > 0) unopened.set(last, excess - 1);
    end -= 1;
  }
  return value.slice(0, end);
}

const MARKER = /^\[REDACTED:(?:aws_access_key|api_token|github_token|bearer_token|assigned_secret|private_key)\]$/u;

export function redactSecrets(text: string): RedactionResult {
  const matches: Array<{ kind: SecretKind; start: number; end: number }> = [];
  for (const detector of DETECTORS) {
    const expression = new RegExp(detector.expression);
    for (let from = 0, match = expression.exec(text); match !== null; from = expression.lastIndex, match = expression.exec(text)) {
      const captured = match[detector.secretGroup];
      const start = match.indices?.[detector.secretGroup]?.[0];
      if (captured === undefined || start === undefined) continue;
      if (detector.kind !== "assigned_secret") { matches.push({ kind: detector.kind, start, end: start + captured.length }); continue; }
      // A name starts at a word boundary at or after where this scan began; a word with none before it ends no name.
      const name = nameStart(text, match.index, from);
      if (name < 0) { expression.lastIndex = match.index + 1; continue; }
      const inQuery = /[?&]/u.test(text.charAt(name - 1));
      const cut = cutAt(captured, inQuery);
      GOES_ON.lastIndex = start + cut;
      const longer = cut === captured.length && GOES_ON.test(text);
      let secret = longer ? captured : withoutTrailingDelimiters(captured.slice(0, cut));
      const left = MARKER.test(secret) || readsAsCode(secret, text.slice(match.index, start), !longer);
      if (!left && longer) secret = withoutTrailingDelimiters(captured + runOn(text, start + cut, inQuery));
      // Scanning resumes after the part masked, so what a cut leaves is scanned like any text, and at the start of a
      // value left in place: `connect(password=...)` reads as code and holds a secret, and in JSON text a value
      // left in place can run on over an escaped line break into the next line.
      expression.lastIndex = left ? Math.max(start, match.index + 1) : start + secret.length;
      if (!left) matches.push({ kind: detector.kind, start, end: start + secret.length });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);

  const accepted: typeof matches = [];
  for (const match of matches) {
    const previous = accepted.at(-1);
    if (previous === undefined || match.start >= previous.end) accepted.push(match);
  }

  let cursor = 0;
  let redacted = "";
  const redactions: SecretRedaction[] = [];
  for (const match of accepted) {
    const replacement = `[REDACTED:${match.kind}]`;
    redacted += text.slice(cursor, match.start) + replacement;
    redactions.push(Object.freeze({ ...match, replacement }));
    cursor = match.end;
  }
  redacted += text.slice(cursor);
  return Object.freeze({
    text: redacted,
    redactions: Object.freeze(redactions),
    patternVersion: REDACTION_PATTERN_VERSION,
  });
}

/**
 * Redacts one string of structured data that is filed under `name`: the string on its own, and as the value
 * assigned to that name, so `{ password: "..." }` is caught without redacting encoded JSON text, whose escapes a
 * text-level redaction can cut through. A value filed under a secret's name is masked whole, whatever it looks
 * like: a passphrase of several words, or one written like a dotted name, is still the secret.
 */
export function redactNamedValue(name: string, value: string): string {
  if (SECRET_FIELD.test(name) && value.trim() !== "" && !/^\[REDACTED:[a-z_]+\]$/u.test(value)) return "[REDACTED:assigned_secret]";
  const own = redactSecrets(value).text;
  const prefix = `${name}: `;
  const assigned = redactSecrets(prefix + own).text;
  return assigned.startsWith(prefix) ? assigned.slice(prefix.length) : own;
}

/**
 * Masks every line of a private key block in a whole file, keeping the line count, so that redaction applied later to
 * one line at a time (a line of a discovery prompt, a range a tool reads) never sees a key's body without its BEGIN
 * and END markers. A block without its END runs to the end of the file.
 */
export function maskPrivateKeyBlocks(text: string): string {
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) return text;
  const lines = text.split("\n");
  let inside = false;
  return lines.map((line) => {
    const begins = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(line);
    if (!inside && !begins) return line;
    inside = !/-----END [A-Z ]*PRIVATE KEY-----/u.test(line);
    return line.endsWith("\r") ? "[REDACTED:private_key]\r" : "[REDACTED:private_key]";
  }).join("\n");
}

/** Context assembly must use this boundary, so raw source text is never returned. */
export function assembleRedactedContext(parts: readonly string[]): RedactionResult {
  return redactSecrets(parts.join("\n"));
}
