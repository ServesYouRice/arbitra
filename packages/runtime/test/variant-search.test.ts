import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import type { HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import { Orchestrator } from "../src/orchestrator.js";
import { readStage } from "../src/pipeline.js";
import { RunStore } from "../src/run-store.js";
import { ModelAuditPipeline } from "../src/model-pipeline.js";
import { snapshotRepository } from "../src/repository.js";
import { replayVariantSearch } from "../src/variant-replay.js";
import { reportedPlaces, variantBatches, variantCandidateId, variantSeeds, withoutDuplicates, type VariantFinding } from "../src/variant-search.js";
import type { AuditFinding } from "../src/auditors.js";
import type { CanonicalIssue, CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";

/*
 * The optional variant search, after verification and before the plan. The models are a fake HTTP provider that answers
 * each stage from what it is sent; no model is called. One finder reports an unchecked JSON.parse in a.ts, which the
 * verifier confirms, and the other an identical line in c.ts, which it rejects. The searcher reads b.ts, c.ts and e.ts
 * and proposes five variants: b.ts (the same defect, high), c.ts (the rejected issue again), d.ts (a file it never read),
 * e.ts (medium, which the medium verifier rejects) and a.ts (the issue itself again).
 */

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const line = (name: string) => `export const parse${name} = (text: string) => JSON.parse(text);`;
type Body = Record<string, unknown>;

async function fixture(options: { readonly variantSearch?: boolean; readonly failVariantCheckOnce?: boolean; readonly searcherFault?: "unknown_issue" | "output_limit"; readonly highOnly?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "arbitra-variant-search-")); directories.push(directory);
  for (const name of ["A", "B", "C", "D", "E"]) await writeFile(join(directory, `${name.toLowerCase()}.ts`), `${line(name)}\n`, "utf8");
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const template = example.models["auditor-a"];
  if (template === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const planTemplate = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const ids = ["auditor-a", "auditor-b", "searcher"];
  const config: RunConfig = runConfigSchema.parse({ ...example, maxConsensusRounds: 0, ...(options.highOnly === true ? { verification: { ...example.verification, belowPlanScope: "skip" } } : {}), models: Object.fromEntries(ids.map((id) => [id, { ...template, independenceGroup: id, modelId: id }])),
    workflow: { preset: "audit-two-finders", critic: false, ...(options.variantSearch === false ? {} : { variantSearch: true }), modelExecution: {
      endpoints: ids.map((id) => ({ id, providerId: "openai", transport: "openai-responses", endpoint: `https://${id}.example/v1`, apiKeyEnvVar: "FIXTURE_KEY" })),
      modelEndpoints: Object.fromEntries(ids.map((id) => [id, id])),
      roles: { planner: "auditor-a", verifier: "auditor-b", mediumVerifier: "auditor-a", ...(options.variantSearch === false ? {} : { variantSearcher: "searcher" }) },
      ...(options.highOnly === true ? { planScope: { minimumSeverity: "high" } } : {}), maximumOutputTokens: 2_000, maximumTokens: 2_000_000, timeoutMs: 30_000, maximumRetries: 0, maximumParallelCalls: 2,
      rateLimits: { openai: { rpm: 1000, tpm: 10_000_000, maxConcurrent: 8 } },
    } } });
  const calls: { stage: string; url: string; question?: string; input?: Record<string, unknown> }[] = [];
  let variantCheckFailures = options.failVariantCheckOnce === true ? 1 : 0;
  const finding = (id: string, path: string, title: string, severity = "high", variantOf?: string) => ({ schemaVersion: 1, sourceFindingId: id, category: "CORRECTNESS", title, severity, status: "likely", confidence: 0.7, productionBlocker: false,
    locations: [{ id: "L1", path, startLine: 1, endLine: 1 }], evidence: [{ id: "E1", text: "JSON.parse(text)", locationIds: ["L1"] }],
    problem: `Unchecked JSON.parse in ${path}`, productionImpact: "A malformed body throws", trigger: "Send malformed JSON", recommendedFix: `Catch the parse error in ${path}`, verification: "Send malformed JSON", dependencies: [], relatedRisks: [], ...(variantOf === undefined ? {} : { variantOf }) });
  const send = async (request: HttpRequest): Promise<HttpResponse> => {
    const input = (request.body as { input: { role?: string; content?: string; type?: string }[] }).input;
    let system = input.find(({ role }) => role === "system")?.content ?? "";
    let user = input.find(({ role }) => role === "user")?.content ?? "{}";
    if (user.startsWith('{"layer":"locked"')) {
      const layers = user.split("\n").map((entry) => JSON.parse(entry) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
      system = layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "";
      const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
      const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
      user = content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    }
    const toolOutputs = input.filter(({ type }) => type === "function_call_output").length;
    const text = (output: unknown): Body => ({ output_text: JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 20 } });
    let reply: Body;
    if (system.startsWith("Audit the supplied")) {
      calls.push({ stage: "discovery", url: request.url });
      const auditorId = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(system)?.[1] ?? "";
      reply = text({ findings: [auditorId.startsWith("auditor-a") ? finding(`${auditorId}/1`, "a.ts", "Unchecked JSON.parse") : finding(`${auditorId}/1`, "c.ts", "Parse without a guard")], truncated: false, unexaminedDueToBudget: [], limitations: [] });
    } else if (system.startsWith("Search this repository for variants")) {
      const parsed = JSON.parse(user) as Record<string, unknown>;
      calls.push({ stage: "variant-search", url: request.url, input: parsed });
      const prefix = /Every sourceFindingId must start with (\S+) and be unique/u.exec(system)?.[1] ?? "";
      const seed = (parsed["issues"] as { issueId: string }[])[0]?.issueId ?? "";
      if (options.searcherFault === "output_limit") return { status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"findings":', usage: { input_tokens: 10, output_tokens: 2_000 } } };
      if (options.searcherFault === "unknown_issue") reply = text({ findings: [finding(`${prefix}1`, "a.ts", "The same unchecked parse", "high", "C-unknown")], limitations: [] });
      else if (toolOutputs === 0) reply = { output: ["b.ts", "c.ts", "e.ts"].map((path, index) => ({ type: "function_call", call_id: `call-${index}`, name: "repo_read_file", arguments: JSON.stringify({ path }) })), usage: { input_tokens: 10, output_tokens: 5 } };
      else reply = text({ findings: [finding(`${prefix}1`, "b.ts", "The same unchecked parse", "high", seed), finding(`${prefix}2`, "c.ts", "The same unchecked parse", "high", seed),
        finding(`${prefix}3`, "d.ts", "The same unchecked parse", "high", seed), finding(`${prefix}4`, "e.ts", "The same unchecked parse", "medium", seed), finding(`${prefix}5`, "a.ts", "The same unchecked parse", "high", seed)], limitations: [] });
    } else if (system.startsWith("Answer the single")) {
      const parsed = JSON.parse(user) as { request: { question: string; context: { citedContext: { evidenceId: string }[] } } };
      calls.push({ stage: "verification", url: request.url, question: parsed.request.question });
      if (variantCheckFailures > 0 && parsed.request.question.includes("e.ts:1")) { variantCheckFailures -= 1; return { status: 503, headers: {}, body: {} }; }
      const outcome = /\b[ab]\.ts:1\b/u.test(parsed.request.question) ? "CONFIRMED" : "REJECTED";
      reply = text({ outcome, evidenceIds: parsed.request.context.citedContext.map(({ evidenceId }) => evidenceId), confidence: 0.8, reason: `Fixture ${outcome}.` });
    } else if (system.startsWith("Produce a complete")) {
      calls.push({ stage: "planner", url: request.url, input: JSON.parse(user) as Record<string, unknown> });
      const parsed = JSON.parse(user) as { canonicalIssues: { candidateId: string }[]; premiseReport: unknown };
      const acceptedIssueIds = parsed.canonicalIssues.map(({ candidateId }) => candidateId);
      reply = text({ ...planTemplate, acceptedIssueIds, tasks: planTemplate.tasks.map((task) => ({ ...task, addresses: { ...task.addresses, issues: acceptedIssueIds } })),
        traceability: { ...planTemplate.traceability, issueToValidation: acceptedIssueIds.map((issueId) => ({ issueId, validationIds: ["VAL-001"] })) }, premiseReport: parsed.premiseReport });
    } else throw new Error(`UNKNOWN_FIXTURE_STAGE:${system.slice(0, 60)}`);
    return { status: 200, headers: {}, body: reply };
  };
  const create = () => new Orchestrator({ repository: directory, stateDirectory: join(directory, ".runs"), providerOptions: { client: { send }, credential: () => "fixture-credential" } });
  const read = async <T>(core: Orchestrator, runId: string, kind: string): Promise<T> => {
    const artifact = (await core.artifacts(runId)).find((entry) => entry.kind === kind);
    if (artifact === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`);
    return JSON.parse((await core.artifact(runId, artifact.artifactId) as { content: string }).content) as T;
  };
  return { directory, config, calls, create, read, send };
}

type Issue = { candidateId: string; disposition: string; verificationOutcome: string | null; sourceFindingIds: string[]; variantOf?: string; severity: string };

describe("the variant search", () => {
  it("proposes the confirmed issue's variants, keeps only the new places it read, verifies them by severity and plans the confirmed one", async () => {
    const setup = await fixture();
    const core = setup.create();
    const run = await core.run(setup.config);
    expect(run.state).toBe("COMPLETED");
    // The run's graph, which the web app draws, has the step between verification and the planner.
    const { workflow } = await core.status(run.runId) as unknown as { workflow: { nodes: { id: string; label: string }[] } };
    expect(workflow.nodes.map(({ id }) => id).slice(-3)).toEqual(["verification", "variant-search", "planner"]);
    expect(workflow.nodes.find(({ id }) => id === "variant-search")?.label).toBe("Searching for variants");
    const issues = (await setup.read<{ issues: Issue[] }>(core, run.runId, "canonical-issues")).issues;
    const seed = issues.find(({ sourceFindingIds }) => sourceFindingIds.some((id) => id.startsWith("auditor-a")));
    if (seed === undefined) throw new Error("SEED_ABSENT");
    expect(seed).toMatchObject({ disposition: "accepted", verificationOutcome: "CONFIRMED" });
    // Only the b.ts variant joins: c.ts repeats the rejected issue, d.ts was never read, e.ts was rejected, a.ts is the issue.
    const variants = issues.filter(({ variantOf }) => variantOf !== undefined);
    expect(variants).toEqual([expect.objectContaining({ variantOf: seed.candidateId, disposition: "accepted", verificationOutcome: "CONFIRMED", severity: "high" })]);
    const variant = variants[0] as Issue;
    expect(variant.candidateId).toMatch(/^V-[0-9a-f]{12}$/u);
    const findings = await setup.read<{ sourceFindingId: string; locations: { path: string }[]; variantOf?: string }[]>(core, run.runId, "source-findings");
    expect(findings.find(({ sourceFindingId }) => sourceFindingId === variant.sourceFindingIds[0])).toMatchObject({ locations: [{ path: "b.ts" }], variantOf: seed.candidateId });
    // The rejected issue stays rejected, and its variant is recorded as such rather than verified again.
    expect(issues.filter(({ disposition }) => disposition === "rejected")).toHaveLength(1);
    const dropped = await setup.read<{ reason: string; disposition?: string }[]>(core, run.runId, "variant-search-duplicates");
    expect(dropped.map(({ reason, disposition }) => [reason, disposition ?? null])).toEqual([["repeats_an_issue", "rejected"], ["restates_its_issue", null]]);
    expect(await setup.read(core, run.runId, "variant-search")).toMatchObject({ seeds: 1, batches: 1, proposed: 4, rejectedOnValidation: 1, duplicates: 2, duplicatesOfRejected: 1, verified: { CONFIRMED: 1, REJECTED: 1, STILL_NEEDS_VERIFICATION: 0 }, added: [variant.candidateId] });
    // The search read the issue's file whole and the other files through the tools; d.ts it never read.
    const search = setup.calls.filter(({ stage }) => stage === "variant-search");
    expect(search.map(({ url }) => url)).toEqual(["https://searcher.example/v1/responses", "https://searcher.example/v1/responses"]);
    const sent = search[0]?.input ?? {};
    expect((sent["repository"] as { path: string }[]).map(({ path }) => path)).toEqual(["a.ts"]);
    expect(sent["alreadyReported"]).toEqual({ "a.ts": ["1"], "c.ts": ["1"] });
    expect(Object.keys(sent["repositoryIndex"] as object)).toContain("directories");
    // Critical and high variants go to the verifier, the rest to the medium verifier.
    const asked = setup.calls.filter(({ stage, question }) => stage === "verification" && /[be]\.ts:1/u.test(question ?? ""));
    expect(asked.map(({ url, question }) => [/([be])\.ts/u.exec(question ?? "")?.[1], url.split("/")[2]])).toEqual(expect.arrayContaining([["b", "auditor-b.example"], ["e", "auditor-a.example"]]));
    expect(asked).toHaveLength(2);
    // The planner plans the variant like any other issue, and the handoff lists it.
    const planned = setup.calls.find(({ stage }) => stage === "planner")?.input?.["canonicalIssues"] as { candidateId: string }[];
    expect(planned.map(({ candidateId }) => candidateId).sort()).toEqual([seed.candidateId, variant.candidateId].sort());
    expect(JSON.stringify(await setup.read(core, run.runId, "implementation"))).toContain(variant.candidateId);
    expect((await setup.read<{ limitations: string[] }>(core, run.runId, "canonical-issues")).limitations).toContain("variant_search_issues_added:1");
  });

  it("resumes without searching a finished batch again, and searches from the issues it started with", async () => {
    // The medium verifier's provider fails once, inside the search's own verification.
    const setup = await fixture({ failVariantCheckOnce: true });
    const failed = await setup.create().run(setup.config);
    expect(failed.state).toBe("FAILED");
    const count = (stage: string) => setup.calls.filter((call) => call.stage === stage).length;
    const searched = count("variant-search"); const verified = count("verification");
    expect(searched).toBe(2);
    const resumed = setup.create();
    await resumed.resume(failed.runId);
    expect((await resumed.wait(failed.runId)).state).toBe("COMPLETED");
    // The finished batch is not searched again, and only the question that failed is asked again.
    expect([count("variant-search"), count("verification")]).toEqual([searched, verified + 1]);
    const store = new RunStore(join(setup.directory, ".runs", "runs"), failed.runId);
    const issues = await readStage<{ issues: Issue[] }>(store, "canonical-issues");
    expect(issues.issues.filter(({ variantOf }) => variantOf !== undefined)).toHaveLength(1);
    // Searched again over the same run, the search starts from the issues verification left, not from its own additions.
    const pipeline = new ModelAuditPipeline({ snapshot: await snapshotRepository(setup.directory), store, auditors: ["auditor-a", "auditor-b"].map((auditorId) => ({ auditorId, independenceGroup: auditorId, ruleIds: [] })), auditorKind: "model_auditors",
      policy: { name: "risk_weighted", quorum: 2, minimumIndependentGroupsForHighRisk: 2 }, maximumRounds: 0, criticEnabled: false, variantSearchEnabled: true }, setup.config, { client: { send: setup.send }, credential: () => "fixture-credential" });
    const calls = setup.calls.length; const summary = await readStage(store, "variant-search");
    try { await pipeline.searchVariants(new AbortController().signal); } finally { await pipeline.close(); }
    expect(setup.calls.length).toBe(calls);
    expect(await readStage(store, "canonical-issues")).toEqual(issues);
    expect(await readStage(store, "variant-search")).toEqual(summary);
  });

  it("replays only the search and the verification of what it finds on a finished run's results, into a store of its own", async () => {
    const setup = await fixture({ variantSearch: false });
    const core = setup.create();
    const run = await core.run(setup.config);
    expect(run.state).toBe("COMPLETED");
    const source = join(setup.directory, ".runs", "runs", run.runId);
    const before = await readFile(join(source, "artifacts.json"), "utf8");
    const calls = setup.calls.length;
    // A file the run never read (as an earlier build read fewer file types) is left out; the files it read still match.
    await writeFile(join(setup.directory, "f.ts"), `${line("F")}\n`, "utf8");
    const output = join(setup.directory, "replays");
    const replay = await replayVariantSearch({ source, output, searcher: "searcher", providerOptions: { client: { send: setup.send }, credential: () => "fixture-credential" } });
    expect(await readFile(join(source, "artifacts.json"), "utf8")).toBe(before);
    const added = setup.calls.slice(calls);
    expect(added.filter(({ stage }) => stage === "variant-search")).toHaveLength(2);
    expect(added.filter(({ stage }) => stage === "verification")).toHaveLength(2);
    expect(added.some(({ stage }) => stage === "discovery" || stage === "planner")).toBe(false);
    expect(replay.summary).toMatchObject({ seeds: 1, proposed: 4, verified: { CONFIRMED: 1, REJECTED: 1 } });
    const store = new RunStore(output, replay.runId);
    const issues = (await readStage<{ issues: Issue[] }>(store, "canonical-issues")).issues;
    expect(issues.filter(({ variantOf }) => variantOf !== undefined)).toHaveLength(1);
    expect(await readStage(store, "variant-replay-source")).toMatchObject({ sourceRunId: run.runId, searcher: "searcher", files: 5 });
    // A searcher the source never had is a copy of one of its profiles with another model, on the same endpoint.
    const other = await replayVariantSearch({ source, output, searcherProfile: { copyOf: "searcher", modelId: "searcher-sonnet" }, effort: "high", providerOptions: { client: { send: setup.send }, credential: () => "fixture-credential" } });
    const execution = (await new RunStore(output, other.runId).loadContext()).modelConfiguration?.workflow["modelExecution"] as { roles: Record<string, string>; modelEndpoints: Record<string, string>; stageEffort: Record<string, string> };
    expect([execution.roles["variantSearcher"], execution.modelEndpoints["variant-searcher"], execution.stageEffort["variantSearch"]]).toEqual(["variant-searcher", "searcher", "high"]);
    expect((await new RunStore(output, other.runId).loadContext()).modelConfiguration?.models["variant-searcher"]?.modelId).toBe("searcher-sonnet");
    expect(other.summary).toMatchObject({ seeds: 1, added: [expect.stringMatching(/^V-/u) as unknown] });
    // A file the run read that changed since refuses the replay, and says which.
    await writeFile(join(setup.directory, "b.ts"), "export const changed = true;\n", "utf8");
    await expect(replayVariantSearch({ source, output, searcher: "searcher", providerOptions: { client: { send: setup.send }, credential: () => "fixture-credential" } })).rejects.toThrow(/RUN_REPOSITORY_CHANGED:.*b\.ts/u);
  });

  it.each(["unknown_issue", "output_limit"] as const)("records a batch the searcher answers wrongly (%s), and the run goes on with the issues verification confirmed", async (searcherFault) => {
    const setup = await fixture({ searcherFault });
    const core = setup.create();
    const run = await core.run(setup.config);
    expect(run.state).toBe("COMPLETED");
    const issues = await setup.read<{ issues: Issue[]; limitations: string[] }>(core, run.runId, "canonical-issues");
    expect(issues.issues.filter(({ variantOf }) => variantOf !== undefined)).toEqual([]);
    expect(issues.limitations).toContain("variant_search_batches_unanswered:1");
    expect(await setup.read(core, run.runId, "variant-search")).toMatchObject({ seeds: 1, batches: 1, unansweredBatches: 1, proposed: 0, added: [] });
    const record = (await core.artifacts(run.runId)).find(({ kind }) => kind.startsWith("variant-search-batch-"));
    expect(JSON.parse((await core.artifact(run.runId, record?.artifactId ?? "") as { content: string }).content)).toMatchObject({ status: "unanswered", reason: expect.stringContaining(searcherFault === "unknown_issue" ? "VARIANT_OF_UNKNOWN_ISSUE" : "MODEL_OUTPUT_LIMIT_REACHED") as unknown });
  });

  it("leaves a variant below the plan's minimum severity unchecked, as verification leaves such an issue", async () => {
    const setup = await fixture({ highOnly: true });
    const core = setup.create();
    const run = await core.run(setup.config);
    expect(run.state).toBe("COMPLETED");
    expect(await setup.read(core, run.runId, "variant-search")).toMatchObject({ proposed: 4, belowPlanScope: 1, verified: { CONFIRMED: 1, REJECTED: 0 } });
    expect(setup.calls.some(({ stage, question }) => stage === "verification" && (question ?? "").includes("e.ts"))).toBe(false);
  });

  it("is off unless switched on, and counts as a step of the estimate when it is on", async () => {
    const off = await fixture({ variantSearch: false });
    const core = off.create();
    const run = await core.run(off.config);
    expect(run.state).toBe("COMPLETED");
    expect(off.calls.some(({ stage }) => stage === "variant-search")).toBe(false);
    expect((await core.artifacts(run.runId)).some(({ kind }) => kind.startsWith("variant-search"))).toBe(false);
    const on = await fixture();
    const estimate = async (setup: typeof on) => (await setup.create().estimate(setup.config) as { estimate: { nodes: number; variantSearch: boolean } }).estimate;
    expect(await estimate(off)).toMatchObject({ nodes: 6, variantSearch: false });
    expect(await estimate(on)).toMatchObject({ nodes: 7, variantSearch: true });
  });
});

describe("the variant search's batches and duplicates", () => {
  const place = (path: string, startLine: number, endLine = startLine) => ({ id: `${path}:${startLine}`, path, startLine, endLine });
  const auditFinding = (sourceFindingId: string, ...locations: ReturnType<typeof place>[]): AuditFinding => ({ sourceFindingId, category: "CORRECTNESS", title: "t", severity: "high", problem: "p", recommendedFix: "f", productionBlocker: false, locations, evidence: [] });
  const issue = (candidateId: string, sourceFindingIds: string[], overrides: Record<string, unknown> = {}) => ({ candidateId, sourceFindingIds, severity: "high", disposition: "accepted", verificationOutcome: "CONFIRMED", ...overrides }) as unknown as CanonicalIssue;
  const variant = (sourceFindingId: string, variantOf: string, ...locations: ReturnType<typeof place>[]) => ({ ...auditFinding(sourceFindingId, ...locations), variantOf }) as unknown as VariantFinding;
  const byId = (...findings: AuditFinding[]) => new Map(findings.map((finding) => [finding.sourceFindingId, finding]));

  it("looks for the variants of confirmed issues at or above the plan's minimum severity", () => {
    const findings = byId(auditFinding("f/1", place("a.ts", 1)), auditFinding("f/2", place("b.ts", 1)), auditFinding("f/3", place("c.ts", 1)));
    const set = { issues: [issue("C-1", ["f/1"]), issue("C-2", ["f/2"], { severity: "low" }), issue("C-3", ["f/3"], { verificationOutcome: "STILL_NEEDS_VERIFICATION", disposition: "needs_verification" })] } as unknown as CanonicalIssueSet;
    expect(variantSeeds(set, findings, "medium").map(({ issue: seed }) => seed.candidateId)).toEqual(["C-1"]);
    expect(variantSeeds(set, findings, undefined).map(({ issue: seed }) => seed.candidateId)).toEqual(["C-1", "C-2"]);
  });

  it("batches the seeds of one module together, a few at a time, and lists the places already reported", async () => {
    const file = (path: string, text: string) => ({ path, lines: [text], lineStartBytes: [0], byteLength: Buffer.byteLength(text) });
    const snapshot = { root: "fixture", files: [file("a.ts", "import { b } from \"./b\";"), file("b.ts", "export const b = 1;"), file("c.ts", "export const c = 1;")] };
    const seed = (id: string, path: string) => ({ issue: issue(id, [`f/${id}`]), findings: [auditFinding(`f/${id}`, place(path, 1))] });
    const seeds = [seed("C-1", "a.ts"), seed("C-2", "c.ts"), seed("C-3", "b.ts"), ...Array.from({ length: 6 }, (_, index) => seed(`C-${index + 4}`, "a.ts"))];
    const batches = await variantBatches(seeds, snapshot, async () => true);
    expect(batches.map((batch) => batch.map(({ issue: seed }) => seed.candidateId))).toEqual([["C-1", "C-3", "C-4", "C-5", "C-6", "C-7"], ["C-2"], ["C-8", "C-9"]]);
    // A batch that would not fit the call is not joined.
    expect((await variantBatches(seeds.slice(0, 3), snapshot, async (batch) => batch.length < 2)).map((batch) => batch.length)).toEqual([1, 1, 1]);
    expect(reportedPlaces([auditFinding("f/1", place("a.ts", 3, 5), place("a.ts", 5, 9), place("a.ts", 12)), auditFinding("f/2", place("b.ts", 1))])).toEqual({ "a.ts": ["3-9", "12"], "b.ts": ["1"] });
  });

  it("keeps a variant that cites its issue's callee beside a place of its own, and drops one that repeats a place already reported", () => {
    const findings = byId(auditFinding("f/1", place("handler-a.ts", 4), place("parse.ts", 1, 3)), auditFinding("f/2", place("handler-c.ts", 4)));
    const issues = [issue("C-1", ["f/1"]), issue("C-2", ["f/2"], { disposition: "rejected", verificationOutcome: "REJECTED" })];
    const { kept, dropped } = withoutDuplicates([
      variant("v/1", "C-1", place("handler-b.ts", 4), place("parse.ts", 2)),
      variant("v/2", "C-1", place("handler-c.ts", 3, 5), place("parse.ts", 2)),
      variant("v/3", "C-1", place("parse.ts", 1)),
      variant("v/4", "C-1", place("handler-b.ts", 4, 6)),
    ], issues, findings);
    expect(kept.map(({ sourceFindingId }) => sourceFindingId)).toEqual(["v/1"]);
    expect(dropped).toEqual([{ sourceFindingId: "v/2", variantOf: "C-1", reason: "repeats_an_issue", duplicateOf: "C-2", disposition: "rejected" },
      { sourceFindingId: "v/3", variantOf: "C-1", reason: "restates_its_issue", duplicateOf: "C-1" }, { sourceFindingId: "v/4", variantOf: "C-1", reason: "repeats_a_variant", duplicateOf: "v/1" }]);
    expect(variantCandidateId("v/1")).toMatch(/^V-[0-9a-f]{12}$/u);
  });
});
