import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUN_CONFIG_FIELD_INVENTORY, runConfigSchema, type RunConfig } from "../packages/schemas/src/config.js";
import { providerExecutionSchema } from "../packages/schemas/src/provider-execution.js";
import { testingExecutionSchema } from "../packages/schemas/src/testing.js";
import { configurationDiagnostics } from "../packages/runtime/src/preflight.js";

/**
 * The documentation gate for `examples/`.
 *
 * A stale example is worse than a missing one, so every shipped configuration is parsed
 * with the same schema the server and CLI use, and each negative control below proves the
 * gate can actually fail.
 */
const directory = dirname(fileURLToPath(import.meta.url));
/** Schema-only examples: schema coverage, not runnable model configurations. */
export const EXAMPLE_NAMES = ["audit-balanced", "audit-deep", "diff-fast", "diff-review", "feature-simple", "testing-plan"] as const;
/** Model-backed templates: pass runtime preflight and are smoke-run through the public
 * runtime by packages/runtime/test/example-smoke.test.ts (`pnpm run smoke:examples`). */
export const MODEL_BACKED_TEMPLATES = ["audit-compatible-chat", "audit-mixed-providers", "feature-automatic", "feature-interactive", "testing-execute", "testing-plan"] as const;
const modelBacked = join(directory, "model-backed");
const WIRE_PROTOCOLS = ["anthropic-messages", "gemini-native", "openai-chat", "openai-responses"];

describe("example configurations", () => {
  it("ships exactly the six documented examples and nothing else", () => {
    expect(readdirSync(directory).filter((name) => name.endsWith(".json")).sort()).toEqual(EXAMPLE_NAMES.map((name) => `${name}.json`).sort());
  });

  it.each(EXAMPLE_NAMES)("%s validates against the shipped run configuration schema", (name) => {
    const parsed = runConfigSchema.parse(load(name));
    expect(parsed.schemaVersion).toBe(1);
    for (const field of RUN_CONFIG_FIELD_INVENTORY) expect(parsed).toHaveProperty(field);
  });

  it("keeps every example internally consistent with its declared mode and scope", () => {
    for (const name of EXAMPLE_NAMES) {
      const config = runConfigSchema.parse(load(name));
      expect(Object.keys(config.models).length).toBeGreaterThan(0);
      expect(config.harness.mode).toBe("canonical");
      if (name.startsWith("diff-")) expect(config.scope.kind).toBe("diff");
      if (name === "feature-simple") expect(config.mode).toBe("feature");
      if (name === "testing-plan") expect(config.mode).toBe("testing");
      if (name.startsWith("audit-") || name.startsWith("diff-")) expect(config.mode).toBe("audit");
    }
  });

  it("declares no resolved credential in any example", () => {
    for (const name of EXAMPLE_NAMES) {
      const raw = readFileSync(join(directory, `${name}.json`), "utf8");
      expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|"apiKey"|"secret"/u);
    }
  });

  it("states model identity as a placeholder rather than fabricating a provider model", () => {
    for (const name of EXAMPLE_NAMES) {
      for (const profile of Object.values(runConfigSchema.parse(load(name)).models)) {
        expect(profile.modelId).toBe("replace-with-your-model-id");
        expect(profile.family).toBe("replace-with-your-model-family");
        expect(profile.limits).toEqual({ contextTokens: null, maxOutputTokens: null });
      }
    }
  });

  it("keeps schema-only examples distinguishable from runnable model-backed templates", () => {
    for (const name of EXAMPLE_NAMES) {
      const config = runConfigSchema.parse(load(name));
      expect(config.workflow["modelExecution"]).toBeUndefined();
      expect(configurationDiagnostics(config).map(({ code }) => code)).toContain("RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED");
    }
  });

  describe("negative controls — a stale example must fail this suite", () => {
    it("rejects an example that drifts to an unknown field", () => {
      expect(() => runConfigSchema.parse({ ...load("audit-balanced"), auditMode: "deep" })).toThrow();
    });

    it("rejects an example that drifts to a removed field", () => {
      const { consensusPolicy: _removed, ...withoutField } = load("audit-balanced") as Record<string, unknown>;
      expect(() => runConfigSchema.parse(withoutField)).toThrow();
    });

    it("rejects an example whose enum value is no longer part of the schema", () => {
      expect(() => runConfigSchema.parse({ ...load("audit-deep"), consensusPolicy: "majority" })).toThrow();
    });

    it("rejects an example whose bounds drift out of range", () => {
      expect(() => runConfigSchema.parse({ ...load("audit-deep"), maxConsensusRounds: 4 })).toThrow();
    });

    it("rejects an example whose model profile drifts", () => {
      const config = load("diff-fast") as { models: Record<string, Record<string, unknown>> };
      const profile = Object.values(config.models)[0]!;
      expect(() => runConfigSchema.parse({ ...config, models: { "auditor-a": { ...profile, capabilityTier: "cheap" } } })).toThrow();
      expect(() => runConfigSchema.parse({ ...config, models: { "auditor-a": { ...profile, structuredOutputDialect: undefined } } })).toThrow();
    });

    it("rejects an example pinned to a superseded schema version", () => {
      expect(() => runConfigSchema.parse({ ...load("testing-plan"), schemaVersion: 0 })).toThrow();
    });
  });
});

describe("model-backed templates", () => {
  const templates = (): [string, RunConfig][] => MODEL_BACKED_TEMPLATES.map((name) => [name, runConfigSchema.parse(loadTemplate(name))]);

  it("ships exactly the documented model-backed templates", () => {
    expect(readdirSync(modelBacked).filter((name) => name.endsWith(".json")).sort()).toEqual(MODEL_BACKED_TEMPLATES.map((name) => `${name}.json`).sort());
  });

  it.each(MODEL_BACKED_TEMPLATES)("%s passes schema validation and runtime configuration preflight", (name) => {
    const config = runConfigSchema.parse(loadTemplate(name));
    for (const field of RUN_CONFIG_FIELD_INVENTORY) expect(config).toHaveProperty(field);
    expect(config.harness.mode).toBe("canonical");
    expect(configurationDiagnostics(config).filter(({ severity }) => severity === "error")).toEqual([]);
  });

  it("covers every wire protocol, Audit, both Feature modes and both Testing modes", () => {
    const configs = templates();
    const transports = new Set(configs.flatMap(([, config]) => Object.values(config.models).map(({ transport }) => transport)));
    expect([...transports].sort()).toEqual(WIRE_PROTOCOLS);
    expect(configs.filter(([, config]) => config.mode === "audit")).not.toHaveLength(0);
    expect(new Set(configs.filter(([, config]) => config.mode === "feature").map(([, config]) => (config.workflow["feature"] as { mode: string }).mode))).toEqual(new Set(["interactive", "automatic"]));
    expect(new Set(configs.filter(([, config]) => config.mode === "testing").map(([, config]) => testingExecutionSchema.parse(config.workflow["testing"]).mode))).toEqual(new Set(["plan", "execute"]));
    const mixed = configs.filter(([, config]) => new Set(Object.values(config.models).map(({ provider }) => provider)).size >= 3 && new Set(Object.values(config.models).map(({ transport }) => transport)).size >= 3);
    expect(mixed.map(([name]) => name)).toContain("audit-mixed-providers");
  });

  it("binds every profile to an endpoint whose credential is an ARBITRA_* environment reference", () => {
    for (const [name, config] of templates()) {
      const raw = readFileSync(join(modelBacked, `${name}.json`), "utf8");
      expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|"apiKey"|"secret"/u);
      const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
      for (const id of Object.keys(config.models)) expect(execution.modelEndpoints[id], `${name}:${id}`).toBeDefined();
      // Dedicated names keep an unrelated exported provider key from enabling spend.
      for (const endpoint of execution.endpoints) expect(endpoint.apiKeyEnvVar).toMatch(/^ARBITRA_[A-Z0-9_]+_API_KEY$/u);
    }
  });

  it("ships no model catalogue: identities are placeholders and limits are operator policy", () => {
    for (const [, config] of templates()) {
      for (const profile of Object.values(config.models)) {
        expect(profile.modelId).toBe("replace-with-your-model-id");
        expect(profile.family).toBe("replace-with-your-model-family");
        expect(profile.limits).toEqual({ contextTokens: null, maxOutputTokens: null });
      }
      const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
      expect(execution.maximumTokens).toBeGreaterThan(0);
      expect(execution.maximumRetries).toBeLessThanOrEqual(1);
      // `budgets` is not an enforced limit; the templates must not imply a cost cap.
      expect(config.budgets).toEqual({});
    }
  });

  it("grants write authority only in the execute template, with a placeholder pinned image", () => {
    for (const [name, config] of templates()) {
      const testing = config.workflow["testing"] === undefined ? undefined : testingExecutionSchema.parse(config.workflow["testing"]);
      expect(testing?.mode === "execute", name).toBe(name === "testing-execute");
      expect(config.verification["execution"], name).toBeUndefined();
      if (testing?.mode === "execute") {
        expect(testing.execution.verification.execution.image).toBe(`replace-with-your-local-test-image@sha256:${"0".repeat(64)}`);
        expect(testing.execution.authorization.partitions.flatMap(({ paths }) => paths).every((path) => /\.test\.[a-z]+$/u.test(path))).toBe(true);
      }
    }
  });

  describe("negative controls", () => {
    it("rejects a template whose profile loses its endpoint binding", () => {
      const config = loadTemplate("feature-automatic") as { workflow: { modelExecution: { modelEndpoints: Record<string, string> } } };
      delete config.workflow.modelExecution.modelEndpoints["planner"];
      expect(() => runConfigSchema.parse(config)).toThrow("Model requires an endpoint");
    });

    it("rejects a template that loses its Audit roles at runtime preflight", () => {
      const config = loadTemplate("audit-mixed-providers") as { workflow: { modelExecution: Record<string, unknown> } };
      delete config.workflow.modelExecution["roles"];
      expect(configurationDiagnostics(runConfigSchema.parse(config)).map(({ code }) => code)).toEqual(["MODEL_EXECUTION_ROLES_REQUIRED"]);
    });
  });
});

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"));
}

function loadTemplate(name: string): unknown {
  return JSON.parse(readFileSync(join(modelBacked, `${name}.json`), "utf8"));
}
