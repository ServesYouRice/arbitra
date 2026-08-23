import {
  INJECTION_RULES,
  type InstructionRiskLevel,
  type RuleMatch,
} from "./rules/index.js";

export const INJECTION_SCANNER_VERSION = "1" as const;

export type InjectionRuleId = (typeof INJECTION_RULES)[number]["id"];

export interface InstructionRiskRange {
  readonly ruleId: InjectionRuleId;
  readonly level: InstructionRiskLevel;
  readonly reason: string;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface InstructionRisk {
  readonly level: InstructionRiskLevel | null;
  readonly reason: string;
  readonly affectedRanges: readonly InstructionRiskRange[];
}

export interface InjectionScanResult {
  readonly path: string;
  readonly scannerVersion: typeof INJECTION_SCANNER_VERSION;
  readonly instructionRisk: InstructionRisk;
}

interface NormalizedContent {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

const LEVEL_WEIGHT: Readonly<Record<InstructionRiskLevel, number>> = {
  low: 1,
  medium: 2,
  high: 3,
};

function normalizeWithSourceMap(content: string): NormalizedContent {
  let text = "";
  let sourceOffset = 0;
  const starts: number[] = [];
  const ends: number[] = [];

  for (const character of content) {
    const normalized = character.normalize("NFKC");
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(sourceOffset);
      ends.push(sourceOffset + character.length);
    }
    sourceOffset += character.length;
  }

  return { text, starts, ends };
}

function sourceRange(match: RuleMatch, normalized: NormalizedContent): { start: number; end: number } | null {
  const start = normalized.starts[match.start];
  const end = normalized.ends[match.end - 1];
  return start === undefined || end === undefined ? null : { start, end };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Produces advisory risk metadata only. The input is never changed, blocked, or
 * upgraded to trusted when no rules match.
 */
export function scan(content: string, path: string): InjectionScanResult {
  const normalized = normalizeWithSourceMap(content);
  const affectedRanges: InstructionRiskRange[] = [];

  for (const rule of INJECTION_RULES) {
    for (const match of rule.detect(normalized.text)) {
      const range = sourceRange(match, normalized);
      if (range === null) continue;
      affectedRanges.push({
        ruleId: rule.id,
        level: rule.level,
        reason: match.reason,
        byteStart: byteLength(content.slice(0, range.start)),
        byteEnd: byteLength(content.slice(0, range.end)),
      });
    }
  }

  affectedRanges.sort(
    (left, right) =>
      left.byteStart - right.byteStart ||
      left.byteEnd - right.byteEnd ||
      left.ruleId.localeCompare(right.ruleId),
  );

  const level = affectedRanges.reduce<InstructionRiskLevel | null>(
    (highest, range) =>
      highest === null || LEVEL_WEIGHT[range.level] > LEVEL_WEIGHT[highest] ? range.level : highest,
    null,
  );
  const ruleIds = [...new Set(affectedRanges.map((range) => range.ruleId))];

  return Object.freeze({
    path,
    scannerVersion: INJECTION_SCANNER_VERSION,
    instructionRisk: Object.freeze({
      level,
      reason:
        level === null
          ? "No scanner rules matched; content remains untrusted"
          : `Matched ${affectedRanges.length} range(s): ${ruleIds.join(", ")}`,
      affectedRanges: Object.freeze(affectedRanges.map((range) => Object.freeze(range))),
    }),
  });
}

export { INJECTION_RULES } from "./rules/index.js";
export type { InjectionRule, InstructionRiskLevel, RuleMatch } from "./rules/index.js";
