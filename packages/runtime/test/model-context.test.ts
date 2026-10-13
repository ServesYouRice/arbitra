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

  it("adds up what each source costs instead of measuring the whole input once per source", () => {
    // Observed live (P20 pilot): one measurement compiled the prompt, and a run made tens of thousands of them.
    const repository = Array.from({ length: 40 }, (_, index) => ({ path: `file-${String(index).padStart(2, "0")}.ts`, content: "x".repeat(100) }));
    const input = { decision: { path: "file-07.ts", startLine: 1, endLine: 1 }, repository };
    const size = (value: unknown) => JSON.stringify(value).length;
    let measurements = 0;
    const measure = (value: unknown) => { measurements += 1; return size(value); };
    const maximum = size({ ...input, repository: [] }) + 2_600;
    const fits = (value: unknown) => measure(value) <= maximum;
    const summed = allocateModelContext(input, fits, [], fits, { sizing: { measure, maximum, of: (source) => size(source) + 1 } });
    expect(measurements).toBeLessThanOrEqual(4);
    // The cited file comes first, and the result is what measuring every step would have chosen.
    const stepped = allocateModelContext(input, (value) => size(value) <= maximum);
    expect(summed.coverage.fullPaths[0]).toBe("file-07.ts");
    expect(summed.coverage.fullPaths.length).toBeGreaterThan(5);
    expect(size(summed.input)).toBeLessThanOrEqual(maximum);
    expect(Math.abs(summed.coverage.fullPaths.length - stepped.coverage.fullPaths.length)).toBeLessThanOrEqual(1);
  });

  it("gives sources back when the sum of their costs was short of the whole", () => {
    const repository = Array.from({ length: 10 }, (_, index) => ({ path: `file-${index}.ts`, content: "x".repeat(100) }));
    const size = (value: unknown) => JSON.stringify(value).length;
    const maximum = size({ repository: [] }) + 700;
    const fits = (value: unknown) => size(value) <= maximum;
    // Each source is counted at half its size, so the sum admits about twice what fits.
    const result = allocateModelContext({ repository }, fits, [], fits, { sizing: { measure: size, maximum, of: (source) => Math.ceil(size(source) / 2) } });
    expect(fits(result.input)).toBe(true);
    expect(result.coverage.fullPaths.length).toBeGreaterThan(0);
    expect(result.coverage.omittedPaths.length).toBeGreaterThan(0);
  });

  it("reads only the cited files when the stage asks for that scope", () => {
    // Observed live (P20 pilot): with the files of the cited files' modules added, a question read 47 of 57 files.
    const input = { finding: { path: "src/billing/charge.ts", startLine: 1, endLine: 1 }, repository: [
      { path: "src/billing/charge.ts", content: "import './tax.js';" }, { path: "src/billing/tax.ts", content: "helper" }, { path: "src/search/index.ts", content: "unrelated" }] };
    const everything = allocateModelContext(input, () => true);
    expect(everything.coverage.fullPaths).toHaveLength(3);
    const scoped = allocateModelContext(input, () => true, [], () => true, { scope: "cited" });
    expect(scoped.coverage).toEqual({ fullPaths: ["src/billing/charge.ts"], excerptPaths: [], omittedPaths: ["src/billing/tax.ts", "src/search/index.ts"] });
    expect(scoped.input).toMatchObject({ contextCoverage: { complete: false, omittedPaths: ["src/billing/tax.ts", "src/search/index.ts"] } });
    expect(scoped.citedPathsLeftOut).toEqual([]);
  });

  it("names the cited files it could carry neither whole nor as an excerpt", () => {
    const input = { finding: { path: "a.ts", startLine: 1, endLine: 1 }, other: { path: "b.ts", startLine: 1, endLine: 1 }, repository: [{ path: "a.ts", content: "short" }, { path: "b.ts", content: "a line far too long to fit ".repeat(10) }] };
    const result = allocateModelContext(input, (value) => bytes(value) <= 10);
    expect(result.coverage.fullPaths).toEqual(["a.ts"]);
    expect(result.citedPathsLeftOut).toEqual(["b.ts"]);
    expect(allocateModelContext(input, () => true).citedPathsLeftOut).toEqual([]);
  });
});
