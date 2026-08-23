export const schemaDialects = ["openai_strict", "gemini", "anthropic_tool"] as const;

export type SchemaDialect = (typeof schemaDialects)[number];

export interface DialectPolicy {
  readonly dialect: SchemaDialect;
  readonly maxNestingDepth: number;
}

export type JsonSchema = Record<string, unknown>;

export interface ProjectionDiagnostic {
  readonly code:
    | "root_union"
    | "nesting_too_deep"
    | "additional_properties"
    | "numeric_bound"
    | "pattern"
    | "optional_property";
  readonly pointer: string;
  readonly message: string;
}
