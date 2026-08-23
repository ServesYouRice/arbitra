import { compile, type CompiledPrompt } from "../compiler.js";
import type { PromptCompileSpec, PromptLayerName } from "../layers.js";

export type LintSeverity = "advisory" | "blocking";
export type PromptLintCode =
  | "LOCKED_RULE_NEGATION"
  | "PROTECTED_READ_ONLY_CONFLICT"
  | "IMPERATIVE_CAPS"
  | "DUPLICATE_PROTOCOL_BLOCK"
  | "OVERSIZED_OVERRIDE"
  | "UNBALANCED_XML"
  | "UNTRUSTED_INSTRUCTION_INJECTION";

export interface LintFinding {
  readonly code: PromptLintCode;
  readonly severity: LintSeverity;
  readonly layer: PromptLayerName;
  readonly message: string;
  readonly rationale: string;
  readonly suggestion: string | null;
}

export interface LintedCompiledPrompt extends CompiledPrompt {
  readonly lintFindings: readonly LintFinding[];
}

export class PromptLintError extends Error {
  readonly findings: readonly LintFinding[];
  readonly report: string;

  constructor(findings: readonly LintFinding[]) {
    super(`Prompt compilation refused: ${findings.filter(({ severity }) => severity === "blocking").length} blocking lint finding(s).`);
    this.name = "PromptLintError";
    this.findings = findings;
    this.report = renderLintReport(findings);
  }
}

const RATIONALES: Readonly<Record<PromptLintCode, string>> = Object.freeze({
  LOCKED_RULE_NEGATION: "An override cannot repeal the locked protocol; contradictory layers reduce reliability and violate the control-plane boundary.",
  PROTECTED_READ_ONLY_CONFLICT: "Audit mode is read-only, so instructions to edit or fix repository code are prohibited.",
  IMPERATIVE_CAPS: "Escalatory all-caps imperatives can cause over-triggering and should use direct, neutral wording.",
  DUPLICATE_PROTOCOL_BLOCK: "Repeating the locked protocol wastes context and can create divergent copies of the controlling rules.",
  OVERSIZED_OVERRIDE: "Large custom instructions weaken cache reuse and can crowd out repository evidence.",
  UNBALANCED_XML: "Malformed structural tags make trust and instruction boundaries ambiguous to the model.",
  UNTRUSTED_INSTRUCTION_INJECTION: "An override must not place instruction-shaped text inside a section explicitly framed as untrusted data.",
});

export function compileLinted(spec: PromptCompileSpec): LintedCompiledPrompt {
  const compiled = compile(spec);
  const lintFindings = lintPrompt(compiled, spec);
  if (lintFindings.some(({ severity }) => severity === "blocking")) throw new PromptLintError(lintFindings);
  return Object.freeze({ ...compiled, lintFindings });
}

export function lintPrompt(compiled: CompiledPrompt, spec: PromptCompileSpec): readonly LintFinding[] {
  const overrides = [spec.overrides.before ?? "", spec.overrides.after ?? ""].filter(Boolean);
  const combined = overrides.join("\n");
  const findings: LintFinding[] = [];

  if (/\b(?:ignore|disregard|override|repeal|bypass)\b[^.\n]{0,100}\b(?:protocol|locked|rule|instruction|read[- ]?only)\b|\bdo\s+not\s+(?:follow|obey)\b/iu.test(combined)) {
    findings.push(finding("LOCKED_RULE_NEGATION", "blocking", "overrides", "Override attempts to negate a locked rule.", "Remove the negation and express only additional, compatible guidance."));
  }
  if (/(?:read[- ]?only|no\s+(?:production\s+)?code\s+modification)/iu.test(spec.protocol.content)
    && /\b(?:fix|modify|edit|write|rewrite|patch|commit)\b[^.\n]{0,60}\b(?:bug|code|file|repository|production)?/iu.test(combined)) {
    findings.push(finding("PROTECTED_READ_ONLY_CONFLICT", "blocking", "overrides", "Override requests repository modification under a read-only protocol.", "Ask for remediation guidance without requesting code changes."));
  }
  const caps = /\b(?:(?:CRITICAL|URGENT|IMPORTANT)\s*:?[ \t]*(?:YOU[ \t]+)?(?:MUST|SHALL|NEVER|ALWAYS)|YOU[ \t]+MUST)\b/gu.exec(combined);
  if (caps !== null) {
    findings.push(finding("IMPERATIVE_CAPS", "advisory", "overrides", `Escalatory imperative found: ${caps[0]}.`, plainForm(combined)));
  }
  const protocolText = spec.protocol.content.trim();
  const outsideLocked = compiled.layers.filter(({ layer }) => layer !== "locked").map(({ value }) => JSON.stringify(value)).join("\n");
  if (protocolText.length >= 24 && outsideLocked.includes(protocolText)) {
    findings.push(finding("DUPLICATE_PROTOCOL_BLOCK", "advisory", "stable_repository", "Locked protocol content is repeated in another layer.", "Remove the duplicate; reference the pinned locked protocol instead."));
  }
  if (new TextEncoder().encode(combined).byteLength > 8_192) {
    findings.push(finding("OVERSIZED_OVERRIDE", "advisory", "overrides", "Combined custom overrides exceed 8192 UTF-8 bytes.", "Move factual context into a bounded artifact and keep the override concise."));
  }
  for (const override of overrides) {
    const xmlProblem = xmlBalanceProblem(override);
    if (xmlProblem !== null) {
      findings.push(finding("UNBALANCED_XML", "advisory", "overrides", xmlProblem, "Balance or remove the structural tags before dispatch."));
      break;
    }
  }
  if (/<repository_content\b[^>]*\btrust\s*=\s*["']untrusted["'][^>]*>[\s\S]*?\b(?:ignore\s+(?:all\s+)?previous|you\s+must|follow\s+(?:these|my)\s+instructions?|system\s+prompt)\b[\s\S]*?<\/repository_content>/iu.test(combined)) {
    findings.push(finding("UNTRUSTED_INSTRUCTION_INJECTION", "blocking", "overrides", "Instruction-shaped text was injected inside an untrusted repository-content frame.", "Remove the frame from the override and provide legitimate guidance in the override layer itself."));
  }
  return Object.freeze(findings);
}

export function renderLintReport(findings: readonly LintFinding[]): string {
  if (findings.length === 0) return "Prompt lint: no findings.";
  return findings.map((item) => `[${item.severity}] ${item.code}: ${item.message}\nRationale: ${item.rationale}${item.suggestion === null ? "" : `\nSuggestion: ${item.suggestion}`}`).join("\n\n");
}

function finding(code: PromptLintCode, severity: LintSeverity, layer: PromptLayerName, message: string, suggestion: string | null): LintFinding {
  return Object.freeze({ code, severity, layer, message, rationale: RATIONALES[code], suggestion });
}

function plainForm(value: string): string {
  const words = value.trim().replace(/[.!?]+$/u, "").toLocaleLowerCase("en-US").replace(/^(critical|urgent|important)\s*:\s*/u, "").replace(/^you\s+/u, "");
  return `${words.charAt(0).toLocaleUpperCase("en-US")}${words.slice(1)}.`;
}

function xmlBalanceProblem(text: string): string | null {
  const tags = text.matchAll(/<\/?([A-Za-z][\w:.-]*)\b[^>]*>/gu);
  const stack: string[] = [];
  for (const match of tags) {
    const token = match[0]; const name = match[1]!;
    if (token.startsWith("</")) {
      if (stack.pop() !== name) return `Closing XML tag </${name}> does not match its opening tag.`;
    } else if (!token.endsWith("/>")) stack.push(name);
  }
  return stack.length === 0 ? null : `XML tag <${stack.at(-1)!}> is not closed.`;
}
