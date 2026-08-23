export const CONTROL_CLASSES = [
  "data",
  "instruction",
  "filesystem_scope",
  "command",
  "external_action",
] as const;

export type ControlClass = (typeof CONTROL_CLASSES)[number];

const EXACT_CLASSES: Readonly<Record<string, ControlClass>> = Object.freeze({
  "sourceFinding.recommendedFix": "instruction",
  "sourceFinding.verification": "instruction",
});

/**
 * Classifies a canonical schema path by effect. Unknown fields fail closed as instruction,
 * so adding a string field cannot silently turn it into trusted control.
 */
export function controlClassOf(schemaPath: string): ControlClass {
  const normalized = normalizeSchemaPath(schemaPath);
  const exact = EXACT_CLASSES[normalized];
  if (exact !== undefined) return exact;
  if (/(?:^|\.)(?:likelyFiles|filesNotToTouch|readFirst|writeScope)(?:\[\])?$/u.test(normalized)) {
    return "filesystem_scope";
  }
  if (/(?:^|\.)(?:command|commands)(?:\[\])?$/u.test(normalized)) return "command";
  if (/(?:^|\.)(?:externalAction|externalActions)(?:\[\])?$/u.test(normalized)) {
    return "external_action";
  }
  if (/^(?:sourceFinding)(?:\.|$)/u.test(normalized)) return "data";
  return "instruction";
}

export function normalizeSchemaPath(schemaPath: string): string {
  return schemaPath.replace(/\[\d+\]/gu, "[]");
}
