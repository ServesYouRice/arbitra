import { z, type ZodType } from "zod";

import { anthropicToolPolicy } from "./dialects/anthropic-tool.js";
import { geminiPolicy } from "./dialects/gemini.js";
import { openaiStrictPolicy } from "./dialects/openai-strict.js";
import type {
  DialectPolicy,
  JsonSchema,
  ProjectionDiagnostic,
  SchemaDialect,
} from "./types.js";

const policies: Readonly<Record<SchemaDialect, DialectPolicy>> = {
  openai_strict: openaiStrictPolicy,
  gemini: geminiPolicy,
  anthropic_tool: anthropicToolPolicy,
};

const numericBounds = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

export class SchemaProjectionError extends Error {
  public constructor(public readonly diagnostics: readonly ProjectionDiagnostic[]) {
    super(diagnostics.map(({ code, pointer }) => `${code} at ${pointer}`).join(", "));
    this.name = "SchemaProjectionError";
  }
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function permitsNull(schema: JsonSchema): boolean {
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some((entry) => isSchema(entry) && permitsNull(entry));
}

function makeNullable(schema: JsonSchema): JsonSchema {
  return permitsNull(schema) ? schema : { anyOf: [schema, { type: "null" }] };
}

function normalize(schema: JsonSchema): JsonSchema {
  const normalized: JsonSchema = {};

  for (const [key, rawValue] of Object.entries(schema)) {
    if (key === "~standard" || numericBounds.has(key) || key === "pattern") continue;
    if (key === "const") {
      normalized.enum = [rawValue];
      continue;
    }
    if (Array.isArray(rawValue)) {
      normalized[key] = rawValue.map((entry) => isSchema(entry) ? normalize(entry) : entry);
      continue;
    }
    normalized[key] = isSchema(rawValue) ? normalize(rawValue) : rawValue;
  }

  if (normalized.type === "object" && isSchema(normalized.properties)) {
    const properties: JsonSchema = {};
    const originallyRequired = new Set(
      Array.isArray(normalized.required)
        ? normalized.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );

    for (const [name, propertySchema] of Object.entries(normalized.properties)) {
      if (!isSchema(propertySchema)) continue;
      properties[name] = originallyRequired.has(name)
        ? propertySchema
        : makeNullable(propertySchema);
    }

    normalized.properties = properties;
    normalized.required = Object.keys(properties);
    normalized.additionalProperties = false;
  }

  return normalized;
}

function inspect(
  schema: JsonSchema,
  policy: DialectPolicy,
  pointer = "",
  depth = 1,
  diagnostics: ProjectionDiagnostic[] = [],
): ProjectionDiagnostic[] {
  if (pointer === "" && (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))) {
    diagnostics.push({
      code: "root_union",
      pointer: "/",
      message: `${policy.dialect} does not permit a root-level union`,
    });
  }
  if (depth > policy.maxNestingDepth) {
    diagnostics.push({
      code: "nesting_too_deep",
      pointer: pointer || "/",
      message: `${policy.dialect} permits at most ${policy.maxNestingDepth} schema nesting levels`,
    });
  }

  for (const [key, value] of Object.entries(schema)) {
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (key === "pattern") {
      diagnostics.push({ code: "pattern", pointer: childPointer, message: "regex constraints are not portable" });
    }
    if (numericBounds.has(key)) {
      diagnostics.push({ code: "numeric_bound", pointer: childPointer, message: "numeric bounds are not portable" });
    }
    if (key === "additionalProperties" && value !== false) {
      diagnostics.push({
        code: "additional_properties",
        pointer: childPointer,
        message: "object schemas must set additionalProperties to false",
      });
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        if (isSchema(entry)) inspect(entry, policy, `${childPointer}/${index}`, depth + 1, diagnostics);
      }
    } else if (isSchema(value)) {
      const nextDepth = key === "properties" ? depth : depth + 1;
      inspect(value, policy, childPointer, nextDepth, diagnostics);
    }
  }

  if (schema.type === "object" && isSchema(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const name of Object.keys(schema.properties)) {
      if (!required.has(name)) {
        diagnostics.push({
          code: "optional_property",
          pointer: `${pointer}/properties/${escapePointer(name)}`,
          message: "wire properties must be required and nullable instead of optional",
        });
      }
    }
  }
  return diagnostics;
}

export function validateProjection(
  schema: JsonSchema,
  dialect: SchemaDialect,
): readonly ProjectionDiagnostic[] {
  return inspect(schema, policies[dialect]);
}

export function projectSchema(schema: ZodType, dialect: SchemaDialect): JsonSchema {
  const generated = z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
    cycles: "throw",
    reused: "inline",
    unrepresentable: "throw",
  }) as unknown as JsonSchema;
  const projected = normalize(generated);
  const diagnostics = validateProjection(projected, dialect);
  if (diagnostics.length > 0) throw new SchemaProjectionError(diagnostics);
  return projected;
}
