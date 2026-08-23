import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sourceFindingSchema, type SourceFinding } from "../../src/finding.js";
import {
  projectSchema,
  SchemaProjectionError,
  schemaDialects,
  type JsonSchema,
} from "../../src/projections/index.js";
import {
  processStructuredOutput,
  StructuredOutputError,
} from "../../src/repair.js";
import { validateSemantics } from "../../src/semantic/index.js";

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../golden");
const finding = sourceFindingSchema.parse(
  JSON.parse(readFileSync(resolve(fixtureDirectory, "source-finding.valid.json"), "utf8")) as unknown,
);

function visit(schema: JsonSchema, callback: (node: JsonSchema) => void): void {
  callback(schema);
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
          visit(entry as JsonSchema, callback);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      visit(value as JsonSchema, callback);
    }
  }
}

describe.each(schemaDialects)("%s projection", (dialect) => {
  it("conforms to the portable wire constraint set", () => {
    const projected = projectSchema(sourceFindingSchema, dialect);
    visit(projected, (node) => {
      expect(node).not.toHaveProperty("pattern");
      expect(node).not.toHaveProperty("minimum");
      expect(node).not.toHaveProperty("maximum");
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        const properties = node.properties as JsonSchema;
        expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(properties)));
      }
    });
  });

  it("projects optional properties as nullable but required", () => {
    const projected = projectSchema(z.object({ required: z.string(), optional: z.string().optional() }), dialect);
    expect(projected.required).toEqual(["required", "optional"]);
    const properties = projected.properties as JsonSchema;
    expect(properties.optional).toMatchObject({ anyOf: expect.any(Array) });
  });

  it("fails a root union with a named diagnostic", () => {
    expect(() => projectSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), dialect))
      .toThrowError(SchemaProjectionError);
    try {
      projectSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), dialect);
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaProjectionError);
      expect((error as SchemaProjectionError).diagnostics[0]?.code).toBe("root_union");
    }
  });

  it("fails schemas deeper than five levels with a named diagnostic", () => {
    const tooDeep = z.object({
      one: z.object({
        two: z.object({
          three: z.object({
            four: z.object({ five: z.string() }),
          }),
        }),
      }),
    });
    try {
      projectSchema(tooDeep, dialect);
      throw new Error("expected projection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaProjectionError);
      expect((error as SchemaProjectionError).diagnostics.some(({ code }) => code === "nesting_too_deep"))
        .toBe(true);
    }
  });
});

describe("semantic finding validation", () => {
  it("rejects paths absent from the snapshot and real line overflows", () => {
    const overflow: SourceFinding = {
      ...finding,
      locations: [
        { ...finding.locations[0]!, endLine: 13 },
        { id: "missing", path: "src/missing.ts", startLine: 1, endLine: 1 },
      ],
    };
    const diagnostics = validateSemantics(overflow, {
      files: { "src/auth.ts": { lineCount: 12 } },
    });
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "line_out_of_range",
      "path_not_in_snapshot",
    ]);
  });

  it("rejects unresolved evidence references", () => {
    const invalid: SourceFinding = {
      ...finding,
      evidence: [{ ...finding.evidence[0]!, locationIds: ["not-there"] }],
    };
    expect(validateSemantics(invalid, { files: { "src/auth.ts": { lineCount: 12 } } }))
      .toContainEqual(expect.objectContaining({ code: "unknown_location_id" }));
  });
});

describe("bounded structured repair", () => {
  const schema = z.object({ id: z.string().min(1) }).strict();

  it("sends exactly one pointer-specific repair and records it", async () => {
    const requests: unknown[] = [];
    const result = await processStructuredOutput({
      schema,
      output: JSON.stringify({ id: 7 }),
      tier: "native_structured",
      requestRepair: async (request) => {
        requests.push(request);
        expect(request.diagnostics).toEqual([expect.objectContaining({ pointer: "/id" })]);
        expect(request).not.toHaveProperty("schema");
        return JSON.stringify({ id: "fixed" });
      },
    });
    expect(requests).toHaveLength(1);
    expect(result.value).toEqual({ id: "fixed" });
    expect(result.callRecord).toEqual({
      structuredOutputTier: "native_structured",
      parseFailures: 1,
      repairCount: 1,
      semanticValidationFailures: 0,
    });
  });

  it("fails clearly after the single repair attempt", async () => {
    let repairs = 0;
    const promise = processStructuredOutput({
      schema,
      output: "not json",
      tier: "json_mode",
      requestRepair: async () => {
        repairs += 1;
        return JSON.stringify({ id: 9 });
      },
    });
    await expect(promise).rejects.toMatchObject({
      name: "StructuredOutputError",
      callRecord: { parseFailures: 2, repairCount: 1 },
    });
    expect(repairs).toBe(1);
  });

  it("records semantic failures without spending a repair", async () => {
    const promise = processStructuredOutput({
      schema,
      output: JSON.stringify({ id: "valid-shape" }),
      tier: "schema_tool_call",
      requestRepair: async () => JSON.stringify({ id: "unused" }),
      validateSemantics: () => [{ code: "path_not_in_snapshot", pointer: "/id", message: "missing" }],
    });
    await expect(promise).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(promise).rejects.toMatchObject({
      callRecord: { repairCount: 0, semanticValidationFailures: 1 },
    });
  });
});
