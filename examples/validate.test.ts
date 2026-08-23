import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUN_CONFIG_FIELD_INVENTORY, runConfigSchema } from "../packages/schemas/src/config.js";

/**
 * The documentation gate for `examples/`.
 *
 * A stale example is worse than a missing one, so every shipped configuration is parsed
 * with the same schema the server and CLI use, and each negative control below proves the
 * gate can actually fail.
 */
const directory = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_NAMES = ["audit-balanced", "audit-deep", "diff-fast", "diff-review", "feature-simple", "testing-plan"] as const;

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

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"));
}
