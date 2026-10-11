export const REDACTION_PATTERN_VERSION = "3" as const;

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

const DETECTORS: readonly Detector[] = [
  { kind: "aws_access_key", expression: /\b(AKIA[0-9A-Z]{16})\b/gu, secretGroup: 1 },
  { kind: "api_token", expression: /\b(sk-[A-Za-z0-9_-]{12,255})\b/gu, secretGroup: 1 },
  { kind: "github_token", expression: /\b((?:gh[opusr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}))\b/gu, secretGroup: 1 },
  { kind: "bearer_token", expression: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/giu, secretGroup: 1 },
  {
    kind: "assigned_secret",
    // The value never ends in a backslash: inside JSON text that backslash escapes the quote after it. Observed
    // live (P20 pilot): a redaction marker followed by an escaped quote was taken for a secret again, the escape
    // was lost with it, and the stored artifact no longer parsed.
    expression: /\b(?:api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?([^\s"']{11,}[^\s"'\\])["']?/giu,
    secretGroup: 1,
  },
  {
    kind: "private_key",
    expression: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/gu,
    secretGroup: 1,
  },
];

export function redactSecrets(text: string): RedactionResult {
  const matches: Array<{ kind: SecretKind; start: number; end: number }> = [];
  for (const detector of DETECTORS) {
    for (const match of text.matchAll(detector.expression)) {
      const secret = match[detector.secretGroup];
      if (secret === undefined || match.index === undefined) continue;
      if (/^\[REDACTED:(?:aws_access_key|api_token|github_token|bearer_token|assigned_secret|private_key)\]$/u.test(secret)) continue;
      const offset = match[0].indexOf(secret);
      matches.push({ kind: detector.kind, start: match.index + offset, end: match.index + offset + secret.length });
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
 * text-level redaction can cut through.
 */
export function redactNamedValue(name: string, value: string): string {
  const own = redactSecrets(value).text;
  const prefix = `${name}: `;
  const assigned = redactSecrets(prefix + own).text;
  return assigned.startsWith(prefix) ? assigned.slice(prefix.length) : own;
}

/** Context assembly must use this boundary, so raw source text is never returned. */
export function assembleRedactedContext(parts: readonly string[]): RedactionResult {
  return redactSecrets(parts.join("\n"));
}
