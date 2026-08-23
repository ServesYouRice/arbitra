export type InstructionRiskLevel = "high" | "medium" | "low";

export interface RuleMatch {
  readonly start: number;
  readonly end: number;
  readonly reason: string;
}

export interface InjectionRule {
  readonly id:
    | "instruction_shaped_text"
    | "imperative_suppression"
    | "hidden_unicode"
    | "suspicious_encoded_payload"
    | "wrapper_breaking_sequence"
    | "model_directed_phrase";
  readonly level: InstructionRiskLevel;
  readonly detect: (content: string) => readonly RuleMatch[];
}

function regexDetector(expression: RegExp, reason: string): (content: string) => readonly RuleMatch[] {
  return (content) =>
    Array.from(content.matchAll(expression), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      reason,
    }));
}

function encodedPayloads(content: string): readonly RuleMatch[] {
  const candidates =
    /\b(?:[A-Za-z0-9+/]{4}){10,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?=$|[^A-Za-z0-9+/=])/gu;
  const matches: RuleMatch[] = [];

  for (const match of content.matchAll(candidates)) {
    let decoded: string;
    try {
      decoded = Buffer.from(match[0], "base64").toString("utf8");
    } catch {
      continue;
    }

    const printable = Array.from(decoded).filter((character) => /[\t\n\r\x20-\x7e]/u.test(character)).length;
    const instructionLike =
      /\b(?:ignore|disregard|override|instructions?|system|assistant|auditor|findings?)\b/iu.test(decoded);
    if (decoded.length === 0 || printable / Array.from(decoded).length < 0.85 || !instructionLike) continue;

    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      reason: "Base64 payload decodes to instruction-shaped text",
    });
  }

  return matches;
}

export const INJECTION_RULES: readonly InjectionRule[] = Object.freeze([
  {
    id: "instruction_shaped_text",
    level: "medium",
    detect: regexDetector(
      /\b(?:instructions?|directives?)\s*:\s*(?:ignore|disregard|follow|obey|override)\b/giu,
      "Instruction-labelled text contains an imperative directive",
    ),
  },
  {
    id: "imperative_suppression",
    level: "high",
    detect: regexDetector(
      /\b(?:ignore|hide|omit|suppress|skip|do\s+not|never)\b[^\r\n]{0,64}\b(?:finding|issue|vulnerabilit(?:y|ies)|security|audit|report)\b/giu,
      "Imperative language attempts to suppress audit output",
    ),
  },
  {
    id: "hidden_unicode",
    level: "high",
    detect: regexDetector(
      /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]+/gu,
      "Hidden, directional, or Unicode tag characters are present",
    ),
  },
  {
    id: "suspicious_encoded_payload",
    level: "medium",
    detect: encodedPayloads,
  },
  {
    id: "wrapper_breaking_sequence",
    level: "high",
    detect: regexDetector(
      /<\s*\/\s*(?:repository_content|tool_output|system|assistant)\s*>|<\s*(?:system|assistant)\b[^>]*>/giu,
      "Text contains a sequence capable of breaking a trusted context wrapper",
    ),
  },
  {
    id: "model_directed_phrase",
    level: "high",
    detect: regexDetector(
      /\b(?:model|auditor|assistant|system|chatgpt|claude|gemini|llm)\b[,:]?\s+(?:must\s+)?(?:ignore|disregard|follow|obey|override)\b/giu,
      "An imperative phrase directly addresses a model or auditor",
    ),
  },
]);
