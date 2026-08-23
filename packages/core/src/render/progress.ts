export interface ProgressValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function validateProgressJsonl(jsonl: string, schema: Readonly<Record<string, unknown>>): ProgressValidationResult {
  const errors: string[] = [];
  const lines = jsonl.split(/\r?\n/u).filter((line) => line.trim() !== "");
  lines.forEach((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { errors.push(`line ${index + 1}: invalid JSON`); return; }
    validateSchema(value, schema, `line ${index + 1}`, errors);
  });
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function validateSchema(value: unknown, schema: Readonly<Record<string, unknown>>, path: string, errors: string[]): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) errors.push(`${path}: value is outside enum`);
  if (schema.type === "object") {
    if (!isObject(value)) { errors.push(`${path}: expected object`); return; }
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}: additional property`);
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (isObject(childSchema)) validateSchema(child, childSchema, `${path}.${key}`, errors);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
    if (isObject(schema.items)) value.forEach((item, index) => validateSchema(item, schema.items as Readonly<Record<string, unknown>>, `${path}[${index}]`, errors));
    return;
  }
  if (schema.type === "string" && typeof value !== "string") errors.push(`${path}: expected string`);
  if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
  if (typeof schema.pattern === "string" && typeof value === "string") {
    try { if (!new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: pattern mismatch`); }
    catch { errors.push(`${path}: invalid schema pattern`); }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
