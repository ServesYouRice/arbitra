import { describe, expect, it } from "vitest";
import { allocateModelContext, allocateStageContext, withinStringBudget } from "../src/model-context.js";

const bytes = (value: unknown): number => {
  const input = value as { repository?: { content: string }[]; repositoryContext?: { content: string }[] };
  return (input.repository ?? input.repositoryContext ?? []).reduce((sum, { content }) => sum + content.length, 0);
};

describe("later-stage source allocation", () => {
  it("prioritizes cited source over unrelated files while retaining required decision data", () => {
    const decision = { candidateId: "C1", evidence: [{ path: "z.ts", startLine: 1, endLine: 1, text: "danger" }] };
    const input = { decision, repository: [{ path: "a.ts", content: "unrelated" }, { path: "z.ts", content: "danger" }] };
    const result = allocateModelContext(input, (value) => bytes(value) <= 8);
    expect(result.coverage).toEqual({ fullPaths: ["z.ts"], excerptPaths: [], omittedPaths: ["a.ts"] });
    expect((result.input as { decision: unknown }).decision).toEqual(decision);
    expect(input.repository).toHaveLength(2);
  });

  it("preserves original line numbers when only a cited excerpt can fit", () => {
    const lines = Array.from({ length: 50 }, (_, index) => index === 24 ? "important" : "unrelated content");
    const result = allocateModelContext({ location: { path: "large.ts", startLine: 25, endLine: 25 }, repository: [{ path: "large.ts", content: lines.join("\n") }] }, (value) => bytes(value) <= 20);
    expect(result.coverage).toMatchObject({ excerptPaths: ["large.ts"], omittedPaths: [] });
    expect(result.input).toMatchObject({ repository: [{ content: "25: important", excerpted: true, lineNumbers: "original_source" }] });
  });

  it("uses explicit planner references and retains an import neighbor before unrelated source", () => {
    const result = allocateModelContext({ canonicalIssues: [{ candidateId: "C1" }], repositoryContext: [{ ref: "a.ts", content: "unrelated" }, { ref: "z.ts", content: "import './y.js';" }, { ref: "y.ts", content: "helper" }] }, (value) => bytes(value) <= 22, ["z.ts"]);
    expect(result.coverage.fullPaths).toEqual(["z.ts", "y.ts"]);
    expect(result.coverage.omittedPaths).toEqual(["a.ts"]);
  });

  it("tells the model whether any source was left out", () => {
    const input = { decision: { candidateId: "C1" }, repository: [{ path: "a.ts", content: "short" }, { path: "z.ts", content: "danger" }] };
    const whole = allocateModelContext(input, (value) => bytes(value) <= 100);
    expect(whole.input).toMatchObject({ contextCoverage: { complete: true, fullPaths: ["a.ts", "z.ts"], omittedPaths: [] } });
    expect(whole.coverage).toEqual({ fullPaths: ["a.ts", "z.ts"], excerptPaths: [], omittedPaths: [] });
    expect(allocateModelContext(input, (value) => bytes(value) <= 6).input).toMatchObject({ contextCoverage: { complete: false, omittedPaths: ["z.ts"] } });
  });

  it("falls back, for a stage that has to be sent, on a smaller form and then on the rate for required input", () => {
    const within = (limit: number) => (value: unknown) => JSON.stringify(value).length <= limit;
    const whole = { decision: "d".repeat(60), repository: [{ path: "a.ts", content: "source" }] };
    const smaller = { decision: "d".repeat(10), repository: whole.repository };
    // As given: with its source, then without it.
    expect(allocateStageContext(whole, { smaller, fits: within(2000) })).toMatchObject({ reduced: false, admittedAsRequired: false, input: { decision: whole.decision, repository: whole.repository } });
    expect(allocateStageContext(whole, { smaller, fits: within(200) })).toMatchObject({ reduced: false, admittedAsRequired: false, input: { decision: whole.decision, repository: [] } });
    // The smaller form, at the usual size.
    expect(allocateStageContext(whole, { smaller, fits: within(150) })).toMatchObject({ reduced: true, admittedAsRequired: false, input: { decision: smaller.decision, repository: [] } });
    // Required input: admitted by the other measure, and it carries no optional source even where that would fit.
    expect(allocateStageContext(whole, { fits: within(150), admits: within(2000) })).toMatchObject({ reduced: false, admittedAsRequired: true, input: { decision: whole.decision, repository: [], contextCoverage: { complete: false, omittedPaths: ["a.ts"] } } });
    expect(allocateStageContext(whole, { smaller, fits: within(100), admits: within(150) })).toMatchObject({ reduced: true, admittedAsRequired: true, input: { decision: smaller.decision, repository: [] } });
    // With no fallback, or when none carries it, the stage is refused as before.
    expect(() => allocateStageContext(whole, { fits: within(150) })).toThrow("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
    expect(() => allocateStageContext(whole, { smaller, fits: within(100), admits: within(120) })).toThrow("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
  });

  it("fails rather than discarding required evidence or plan data", () => {
    expect(() => allocateModelContext({ canonicalIssues: ["required"], repository: [] }, () => false)).toThrow("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
    expect(withinStringBudget({ source: "x".repeat(1000) }, 100)).toBe(false);
    expect(withinStringBudget({ source: "small" }, 100)).toBe(true);
  });
});
