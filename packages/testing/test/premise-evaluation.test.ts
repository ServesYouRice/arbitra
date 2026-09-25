import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import type { RunConfig } from "@arbitra/schemas/config.js";

import { analyse, type EvaluationRecord } from "../src/premise-evaluation/analysis.js";
import { corpusImport, persistCorpus } from "../src/premise-evaluation/corpus.js";
import { abandonRun, assertNoLeak, executeProtocol, prepareCheckout, runPaths, singleAuditorConfiguration } from "../src/premise-evaluation/driver.js";
import { matchFinding } from "../src/premise-evaluation/matching.js";
import { loadGroundTruth, loadProtocol, validateProtocol, type EvaluationProtocol } from "../src/premise-evaluation/protocol.js";
import { normalQuantile, pairedBootstrap, wilson } from "../src/premise-evaluation/statistics.js";
import type { PremiseGroundTruth } from "../src/metrics/premise.js";
import { PREMISE_SOURCE, premiseProvider } from "./premise-provider.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) {
    const resolved = resolve(path);
    if (!resolved.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("UNSAFE_TEST_CLEANUP_PATH");
    await rm(resolved, { recursive: true, force: true });
  }
});

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
const committedConfiguration = JSON.parse(readFileSync(join(repositoryRoot, "docs/qa/p06/configs/audit-mixed-providers.json"), "utf8")) as RunConfig;

const truth: PremiseGroundTruth = { fixtureId: "smoke-fixture", version: 1, items: [
  { id: "SMOKE-DEFECT", kind: "defect", category: "correctness", path: "src/session.ts", location: "sessionVersion", detectionCriteria: "Reports the unchecked session version.", rationale: "Fixture defect for driver tests." },
  { id: "SMOKE-DECOY", kind: "decoy", category: "correctness", path: "src/other.ts", location: "other", detectionCriteria: "Does not report the constant.", rationale: "Fixture decoy for driver tests." },
] };

/**
 * A repository root laid out like the real one: fixture source, ground truth beside it (never
 * inside), and a committed-shaped configuration whose limits suit an offline provider.
 */
async function workspace(overrides: Partial<EvaluationProtocol> = {}) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-p06-driver-"));
  roots.push(root);
  await mkdir(join(root, "fixture", "repo", "src"), { recursive: true });
  await writeFile(join(root, "fixture", "repo", "src", "session.ts"), `${PREMISE_SOURCE}\n`);
  await writeFile(join(root, "fixture", "repo", "src", "other.ts"), "export const other = 2;\n");
  await writeFile(join(root, "fixture", "repo", "NOTES.md"), "Grading notes live elsewhere.\n");
  await writeFile(join(root, "fixture", "ground-truth.json"), JSON.stringify(truth));
  const config = structuredClone(committedConfiguration) as RunConfig & { workflow: { modelExecution: { rateLimits: Record<string, unknown>; maximumRetries: number } } };
  config.workflow.modelExecution.rateLimits = Object.fromEntries(Object.keys(config.workflow.modelExecution.rateLimits).map((provider) => [provider, { rpm: 100_000, tpm: 1_000_000_000, maxConcurrent: 4 }]));
  config.workflow.modelExecution.maximumRetries = 0;
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  const protocol = validateProtocol({
    schemaVersion: 1, protocolId: "p06-driver-test", version: "1.0.0", configuration: "config.json", singleAuditor: { auditorId: "auditor-a", preset: "diff-fast" },
    fixtures: [{ id: "smoke-fixture", source: "fixture/repo", groundTruth: "fixture/ground-truth.json", exclude: ["NOTES.md"], rubric: {
      "SMOKE-DEFECT": { path: "src/session.ts", startLine: 1, endLine: 1, keywords: "session version", minimumSeverity: "medium" },
      "SMOKE-DECOY": { path: "src/other.ts", startLine: 1, endLine: 1, keywords: null, minimumSeverity: null },
    } }],
    schedule: [{ fixtureId: "smoke-fixture", condition: "single", repetition: 1 }, { fixtureId: "smoke-fixture", condition: "heterogeneous", repetition: 1 }, { fixtureId: "smoke-fixture", condition: "single", repetition: 2 }],
    budget: { maximumModelRequests: 500, maximumTokens: 10_000_000, maximumWallClockMs: 3_600_000 },
    analysis: { bootstrapIterations: 500, seed: 7, confidence: 0.95 },
    ...overrides,
  });
  return { root, protocol, state: join(root, "state"), evidence: join(root, "evidence") };
}

async function records(evidence: string): Promise<EvaluationRecord[]> {
  const directory = join(evidence, "runs");
  return Promise.all((await readdir(directory)).sort().map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as EvaluationRecord));
}

/** Fails every planner request with a non-retryable 400 until `healed` is set. */
function failingPlanner(options: TransportFactoryOptions): { readonly providerOptions: TransportFactoryOptions; heal(): void } {
  let healed = false;
  const client = options.client;
  if (client === undefined) throw new Error("FIXTURE_CLIENT_ABSENT");
  return { heal() { healed = true; }, providerOptions: { ...options, client: { async send(request: HttpRequest): Promise<HttpResponse> {
    if (!healed && JSON.stringify(request.body).includes("Produce a complete")) return { status: 400, headers: {}, body: { error: { message: "fixture planner outage" } } };
    return client.send(request);
  } } } };
}

describe("P06 premise evaluation driver (scripted providers, no credentials)", () => {
  it("runs the public Orchestrator per schedule, keeps answers out of checkouts, scores and persists", async () => {
    const { root, protocol, state, evidence } = await workspace();
    const provider = premiseProvider();
    const result = await executeProtocol({ root, protocol, stateRoot: state, evidenceDirectory: evidence, providerOptions: provider.providerOptions, clock: (() => { let tick = 0; return () => (tick += 1000); })(), now: () => "2026-09-25T00:00:00Z" });
    expect(result.stoppedReason).toBeNull();
    expect(Object.values(result.ledger.runs).map(({ status }) => status)).toEqual(["completed", "completed", "completed"]);
    expect(provider.calls.some(({ protocol: wire }) => wire === "openai-chat")).toBe(true);
    expect(provider.calls.some(({ stage }) => stage === "audit-critic")).toBe(true);

    // Only fixture source is audited: no ground truth, no excluded notes, one fixed commit for every repetition.
    const checkout = runPaths(state, "smoke-fixture/single/r1").checkout;
    expect((await readdir(join(checkout, "src"))).sort()).toEqual(["other.ts", "session.ts"]);
    expect((await readdir(checkout)).sort()).toEqual([".git", "src"]);
    const saved = await records(evidence);
    expect(saved.map(({ key }) => key)).toEqual(["smoke-fixture/heterogeneous/r1", "smoke-fixture/single/r1", "smoke-fixture/single/r2"]);
    expect(new Set(saved.map(({ record }) => record.snapshot.gitHead)).size).toBe(1);
    const heterogeneous = saved.find(({ condition }) => condition === "heterogeneous")?.record;
    expect(heterogeneous?.auditors.map(({ auditorId, independenceGroup }) => [auditorId, independenceGroup])).toEqual([["auditor-a", "gemini-3.1-flash-lite"], ["auditor-b", "gemini-3.5-flash-lite"], ["auditor-c", "gemini-3.1-flash-lite"]]);
    expect(heterogeneous?.identity.models.map(({ transportId }) => transportId)).toEqual(["gemini-native", "gemini-native", "openai-chat"]);
    expect(saved.find(({ key }) => key === "smoke-fixture/single/r1")?.record.auditors.map(({ auditorId }) => auditorId)).toEqual(["auditor-a"]);

    const truths = new Map([["smoke-fixture", loadGroundTruth(root, protocol.fixtures[0] as EvaluationProtocol["fixtures"][number])]]);
    const report = analyse(protocol, truths, saved, "scripted");
    const condition = (name: string) => report.conditions.find(({ condition: value }) => value === name);
    expect(report.conditions.map(({ condition: value }) => value)).toEqual(["A", "A_pipeline", "B", "C", "D", "D_not_rejected"]);
    expect(condition("A")?.recall).toMatchObject({ successes: 2, trials: 2, estimate: 1 });
    expect(condition("B")?.recall).toMatchObject({ successes: 1, trials: 1 });
    expect(condition("C")?.precision).toMatchObject({ successes: 3, trials: 3 });
    expect(condition("D")?.recall.estimate).toBe(1);
    // Repeated calls of one model stay one independence group; a same-model endpoint does not become a new family.
    expect(report.contribution.B?.byPosition.map(({ identities }) => identities)).toEqual([["gemini-3.1-flash-lite@gemini-native [gemini-3.1-flash-lite]"], ["gemini-3.1-flash-lite@gemini-native [gemini-3.1-flash-lite]"]]);
    expect(report.contribution.B?.byPosition.map(({ uniqueTrue, marginalTrue }) => [uniqueTrue, marginalTrue])).toEqual([[0, 1], [0, 0]]);
    expect(report.verification.items).toBeGreaterThan(0);
    expect(report.comparisons.map(({ left, right }) => `${left}-${right}`)).toEqual(["C-B", "B-A", "C-A", "D-A_pipeline"]);
    expect(report.decision.heterogeneousOverRepeated).toBe("insufficient_evidence");
    expect(report.decision.statement).toContain("untested");

    const bundle = corpusImport(protocol, truths, saved, "scripted", "2026-09-25T00:00:00Z");
    expect(bundle.runs?.map(({ runId }) => runId)).toContain("p06-driver-test-1.0.0-smoke-fixture-single-repetitions-1-2");
    const corpus = join(evidence, "corpus");
    const first = await persistCorpus(corpus, bundle, () => 0);
    expect(first.appended).toBeGreaterThan(0);
    expect(first.independenceReport.report.observations.some(({ judgmentVersion }) => judgmentVersion === 1)).toBe(true);
    expect(bundle.observations?.filter((observation) => observation.findingId === "discovery:SMOKE-DEFECT").map((observation) => observation.corpus === "independence" ? observation.independentlyFoundBy : [])).toEqual([["auditor-a", "auditor-b", "auditor-c"], ["repetition-1", "repetition-2"]]);
    const again = await persistCorpus(corpus, bundle, () => 0);
    expect(again.appended).toBe(0);
    expect(again.independenceReport.status).toBe("unchanged");
  }, 120_000);

  it("resumes an incomplete run from a fresh driver invocation instead of restarting it", async () => {
    const { root, protocol, state, evidence } = await workspace({ schedule: [{ fixtureId: "smoke-fixture", condition: "single", repetition: 1 }] });
    const provider = failingPlanner(premiseProvider().providerOptions);
    const first = await executeProtocol({ root, protocol, stateRoot: state, evidenceDirectory: evidence, providerOptions: provider.providerOptions });
    const entry = first.ledger.runs["smoke-fixture/single/r1"];
    expect(entry?.status).toBe("incomplete");
    expect(first.stoppedReason).toMatch(/^run_incomplete:smoke-fixture\/single\/r1:/u);
    provider.heal();
    const second = await executeProtocol({ root, protocol, stateRoot: state, evidenceDirectory: evidence, providerOptions: provider.providerOptions });
    const resumed = second.ledger.runs["smoke-fixture/single/r1"];
    expect(resumed?.runId).toBe(entry?.runId);
    expect(resumed?.status).toBe("completed");
    expect(resumed?.segments.map(({ kind }) => kind)).toEqual(["start", "resume"]);
    expect(second.stoppedReason).toBeNull();
  }, 120_000);

  it("retires an unresumable run as an adverse result, keeps its discovery and continues the schedule", async () => {
    const { root, protocol, state, evidence } = await workspace({ schedule: [{ fixtureId: "smoke-fixture", condition: "single", repetition: 1 }, { fixtureId: "smoke-fixture", condition: "single", repetition: 2 }] });
    const failing = failingPlanner(premiseProvider().providerOptions);
    expect((await executeProtocol({ root, protocol, stateRoot: state, evidenceDirectory: evidence, providerOptions: failing.providerOptions })).ledger.runs["smoke-fixture/single/r1"]?.status).toBe("incomplete");
    await expect(abandonRun({ root, protocol, stateRoot: state, evidenceDirectory: evidence }, "smoke-fixture/single/r2", "absent")).rejects.toThrow("P06_ABANDON_REQUIRES_INCOMPLETE_RUN:smoke-fixture/single/r2:absent");
    expect((await abandonRun({ root, protocol, stateRoot: state, evidenceDirectory: evidence }, "smoke-fixture/single/r1", "planner outage")).status).toBe("abandoned");
    const next = await executeProtocol({ root, protocol, stateRoot: state, evidenceDirectory: evidence, providerOptions: premiseProvider().providerOptions });
    expect(next.completed).toEqual(["smoke-fixture/single/r2"]);
    expect(next.stoppedReason).toBeNull();
    const saved = await records(evidence);
    const report = analyse(protocol, new Map([["smoke-fixture", truth]]), saved, "scripted");
    expect(report.pipelineFailures).toEqual([{ key: "smoke-fixture/single/r1", runId: next.ledger.runs["smoke-fixture/single/r1"]?.runId, reason: "planner outage", discoveryScored: true }]);
    expect(report.conditions.find(({ condition }) => condition === "A")?.instances).toBe(2);
    expect(report.conditions.find(({ condition }) => condition === "A_pipeline")?.instances).toBe(1);
    expect(report.missingRuns).toEqual([]);
  }, 120_000);

  it("stops before a run once the prespecified request budget is spent", async () => {
    const { root, protocol, state, evidence } = await workspace({ budget: { maximumModelRequests: 1, maximumTokens: 10_000_000, maximumWallClockMs: 3_600_000 } });
    const result = await executeProtocol({ root, protocol, stateRoot: state, evidenceDirectory: evidence, providerOptions: premiseProvider().providerOptions });
    expect(result.completed).toEqual(["smoke-fixture/single/r1"]);
    expect(result.stoppedReason).toMatch(/^maximum_model_requests:\d+\/1$/u);
    expect(Object.keys(result.ledger.runs)).toEqual(["smoke-fixture/single/r1"]);
  }, 120_000);

  it("refuses a checkout that would expose ground truth to the auditors", async () => {
    const { root, protocol } = await workspace();
    const fixture = protocol.fixtures[0] as EvaluationProtocol["fixtures"][number];
    await writeFile(join(root, "fixture", "repo", "src", "hint.ts"), "// see SMOKE-DEFECT\n");
    await expect(async () => prepareCheckout(root, fixture, truth, join(root, "leaky"))).rejects.toThrow("P06_GROUND_TRUTH_LEAK:src/hint.ts");
    await mkdir(join(root, "named"), { recursive: true });
    await writeFile(join(root, "named", "ground-truth.json"), "{}");
    expect(() => assertNoLeak(join(root, "named"), truth)).toThrow("P06_GROUND_TRUTH_LEAK:ground-truth.json");
  });
});

describe("P06 scoring rules", () => {
  const protocol = loadProtocol(join(repositoryRoot, "docs/qa/p06/protocol.json"));
  const live = protocol.fixtures.find(({ id }) => id === "live-fixture-v1") as EvaluationProtocol["fixtures"][number];
  const finding = (path: string, startLine: number, endLine: number, title: string, severity = "medium") => ({ title, problem: "", recommendedFix: "", severity, locations: [{ path, startLine, endLine }] });

  it("covers every committed ground-truth item with a rubric entry and loads every fixture", () => {
    for (const fixture of protocol.fixtures) expect(loadGroundTruth(repositoryRoot, fixture).fixtureId).toBe(fixture.id);
  });

  it("matches a defect only by cited span and stated mechanism, a decoy by span alone", () => {
    expect(matchFinding(finding("src/cart.js", 17, 17, "parseQuantity returns NaN for text"), live)).toMatchObject({ classification: "true_defect", matchedGroundTruthIds: ["quantity-parse"], severityAdequate: true });
    expect(matchFinding(finding("src/cart.js", 17, 17, "Rename this helper"), live)).toMatchObject({ classification: "unlisted", matchedGroundTruthIds: [] });
    expect(matchFinding(finding("src/cart.js", 6, 6, "Negative quantity lowers the subtotal"), live)).toMatchObject({ classification: "decoy", matchedGroundTruthIds: ["subtotal-correct"] });
    expect(matchFinding(finding("./src/session.js", 11, 11, "Session still valid at exactly expiresAt", "informational"), live)).toMatchObject({ classification: "true_defect", severityAdequate: false });
  });

  it("derives the single-auditor baseline from the same profile, endpoint and limits", () => {
    const config = singleAuditorConfiguration(committedConfiguration, "auditor-a");
    const execution = config.workflow["modelExecution"] as unknown as { endpoints: readonly { id: string }[]; roles: unknown; maximumTokens: number; maximumOutputRepairs: number };
    expect(Object.keys(config.models)).toEqual(["auditor-a"]);
    expect(config.models["auditor-a"]).toEqual(committedConfiguration.models["auditor-a"]);
    expect(config.workflow["preset"]).toBe("diff-fast");
    expect(execution.endpoints.map(({ id }) => id)).toEqual(["gemini-native"]);
    expect(execution.roles).toEqual({ planner: "auditor-a", verifier: "auditor-a" });
    expect(execution.maximumOutputRepairs).toBe(2);
    expect(config.auditDepth).toBe(committedConfiguration.auditDepth);
  });

  it("rejects an invalid protocol before anything runs", () => {
    expect(() => validateProtocol({ ...protocol, schedule: [...protocol.schedule, protocol.schedule[0]] })).toThrow("INVALID_PREMISE_PROTOCOL:schedule.premise-v1/single/r1:duplicate");
    expect(() => validateProtocol({ ...protocol, budget: { ...protocol.budget, maximumModelRequests: 0 } })).toThrow("INVALID_PREMISE_PROTOCOL:budget");
  });

  it("reports proportions with denominators and reproducible intervals", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(wilson(5, 10, 0.95)).toEqual({ successes: 5, trials: 10, estimate: 0.5, interval: [0.2366, 0.7634] });
    expect(wilson(0, 0, 0.95)).toEqual({ successes: 0, trials: 0, estimate: null, interval: null });
    const pairs = [[1, 0], [1, 1], [0, 0], [1, 0]] as const;
    expect(pairedBootstrap(pairs, 1000, 3, 0.95)).toEqual(pairedBootstrap(pairs, 1000, 3, 0.95));
    expect(pairedBootstrap(pairs, 1000, 3, 0.95).estimate).toBe(0.5);
    expect(pairedBootstrap([], 1000, 3, 0.95).interval).toBeNull();
  });
});
