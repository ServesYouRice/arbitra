import { describe, expect, it } from "vitest";
import { compile } from "../../src/prompt/compiler.js";
import { renderedPromptProvenance } from "../../src/prompt/provenance.js";
import type { PromptCompileSpec, PromptSecurityBoundary } from "../../src/prompt/layers.js";

const security: PromptSecurityBoundary = {
  redact(text) {
    const expression = /SECRET_[A-Z0-9]+/gu;
    const matches = text.match(expression) ?? [];
    return { text: text.replace(expression, "[REDACTED]"), redactionCount: matches.length };
  },
  frame(text, meta) {
    return `<repository_content trust="untrusted" source_id="${meta.sourceId}">${text}</repository_content>`;
  },
};

function spec(round = "round-a", modelId = "model-a"): PromptCompileSpec {
  return {
    protocol: { protocolId: "audit", protocolVersion: "1.0.0", protocolHash: "a".repeat(64), content: "Locked rules" },
    outputSchema: { z: "last", a: "first" }, toolDefinitions: { read: true },
    projectContext: { language: "TypeScript" },
    stableRepositoryArtifacts: [{ sourceId: "repo", path: "src/a.ts", content: "token=SECRET_ABC" }],
    roundArtifacts: [{ sourceId: round, content: `issues:${round}` }],
    overrides: { before: "be precise", after: "SECRET_OVERRIDE" },
    instruction: "Audit the supplied scope.", outputContract: "Return JSON.", nodeId: "discover", modelId, security,
  };
}

describe("prompt compiler", () => {
  it("produces stable bytes, hash, fixed order and cache boundaries", () => {
    const first = compile(spec()); const second = compile(spec());
    expect(first.bytes).toEqual(second.bytes); expect(first.hash).toBe(second.hash);
    expect(first.layers.map(({ layer }) => layer)).toEqual(["locked", "stable_repository", "round", "overrides", "instruction"]);
    expect(first.breakpoints.map(({ afterLayer }) => afterLayer)).toEqual(["locked", "stable_repository", "round"]);
    expect(first.text.lastIndexOf("Audit the supplied scope.")).toBeGreaterThan(first.text.lastIndexOf("be precise"));
  });

  it("gives fan-out auditors the same prefix through the round breakpoint", () => {
    const prompts = ["a", "b", "c"].map((model) => compile(spec("same-round", model)));
    expect(new Set(prompts.map((prompt) => prompt.breakpoints[2]!.prefixHash)).size).toBe(1);
    expect(new Set(prompts.map((prompt) => prompt.hash)).size).toBe(1);
  });

  it("redacts before framing and records complete compile and rendered provenance", () => {
    const prompt = compile(spec());
    expect(prompt.text).not.toContain("SECRET_"); expect(prompt.text).toContain("[REDACTED]");
    expect(prompt.text).toContain('trust=\\"untrusted\\"');
    expect(prompt.provenance).toMatchObject({ protocolId: "audit", protocolVersion: "1.0.0", protocolHash: "a".repeat(64), nodeId: "discover", modelId: "model-a", promptHash: prompt.hash, redactionCount: 2 });
    expect(renderedPromptProvenance("auditor-a", new TextEncoder().encode(`${prompt.text}\nprovider-rendering`)).renderedPromptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when repository content is not framed", () => {
    expect(() => compile({ ...spec(), security: { ...security, frame: (text) => text } })).toThrow("unframed repository content");
  });
});
