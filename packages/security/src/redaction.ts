export const REDACTION_PATTERN_VERSION = "1" as const;

export type SecretKind =
  | "aws_access_key"
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
  { kind: "github_token", expression: /\b((?:gh[opusr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}))\b/gu, secretGroup: 1 },
  { kind: "bearer_token", expression: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/giu, secretGroup: 1 },
  {
    kind: "assigned_secret",
    expression: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?([^\s"']{12,})["']?/giu,
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

/** Context assembly must use this boundary, so raw source text is never returned. */
export function assembleRedactedContext(parts: readonly string[]): RedactionResult {
  return redactSecrets(parts.join("\n"));
}
