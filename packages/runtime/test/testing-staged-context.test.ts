import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { HttpRequest } from "@arbitra/providers/transport-contract.js";
import { modelTestingAnalysis } from "../src/model-testing-analysis.js";
import { snapshotRepository } from "../src/repository.js";
import { RunStore } from "../src/run-store.js";
import { TestingPipeline } from "../src/testing-pipeline.js";
import { taskOutline } from "../src/planner-context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function payload(request: HttpRequest): { system: string; input: Record<string, unknown> } {
  const body = request.body as { input?: { role: string; content: string }[] };
  const user = body.input?.find(({ role }) => role === "user")?.content ?? "";
  const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
  const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
  const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
  return { system: layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "",
    input: JSON.parse(content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as Record<string, unknown> };
}

it.each(["complete", "interrupted", "output-limited"] as const)("selects an oversized gap candidate set through bounded durable batches: %s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "testing-selection-")); roots.push(root);
  const surfaces = ["auth", "session", "billing", "export"];
  await writeFile(join(root, "app.ts"), surfaces.map((id) => `export const ${id} = false;`).join("\n") + "\n");
  await writeFile(join(root, "app.unit.test.ts"), "test('unrelated', () => {});\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  const snapshot = await snapshotRepository(root, 10, { includeTestMetadata: true });
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "testing", scope: { kind: "repository" }, models: { analyst: { ...profile, capabilityTier: "frontier" } }, workflow: {
    testing: { mode: "plan", goal: "Prevent production failures", roles: { analyst: "analyst", planner: "analyst" } },
    modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { analyst: "primary" }, maximumOutputTokens: 2000, maximumContextTokens: 36_000, maximumTokens: 10_000_000, maximumRetries: 0, timeoutMs: 30_000,
      rateLimits: { [profile.provider]: { rpm: 1000, tpm: 10_000_000, maxConcurrent: 4 } } },
  } });
  // Each grounded surface is individually large; the complete candidate set cannot fit one selection request.
  const risk = { summary: "Several independent production surfaces", reviewedSourcePaths: ["app.ts"], reviewedTestPaths: ["app.unit.test.ts"], limitations: [],
    surfaces: surfaces.map((id, index) => ({ id, paths: ["app.ts"], categories: ["unit", "integration"], severity: index === 0 ? "critical" : "high",
      failureModes: [`${id} regression: ` + "silently accepts an invalid state transition. ".repeat(60)],
      evidence: [{ path: "app.ts", startLine: index + 1, endLine: index + 1, text: `export const ${id} = false;` }] })) };
  const selections: string[][] = []; const activities: string[] = [];
  let calls = 0; let interrupt = scenario === "interrupted"; let truncate = scenario === "output-limited";
  const options = { signal: new AbortController().signal, transport: { credential: () => "fixture-credential", client: { async send(request: HttpRequest) {
    calls += 1;
    const { system, input } = payload(request);
    if (system.startsWith("Identify production-risk")) return { status: 200, headers: {}, body: { output_text: JSON.stringify(risk), usage: { input_tokens: 20, output_tokens: 30 } } };
    const ids = (input["candidates"] as { id: string }[]).map(({ id }) => id);
    selections.push(ids);
    if (interrupt && selections.length === 2) { interrupt = false; throw new Error("FIXTURE_INTERRUPTED"); }
    if (truncate && ids.length > 1) { truncate = false; return { status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"selectedGapIds":[', usage: { input_tokens: 20, output_tokens: 2000 } } }; }
    const selection = { selectedGapIds: ids.filter((id) => id.endsWith("-1")), rejected: ids.filter((id) => !id.endsWith("-1")).map((gapId) => ({ gapId, reason: `Integration coverage for ${gapId} is lower risk than the unit gap.` })), limitations: [] };
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(selection), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } } };
  const store = () => new RunStore(join(root, ".runs"), "run");
  if (scenario === "interrupted") await expect(modelTestingAnalysis(store(), config, snapshot, options)).rejects.toThrow("Provider openai failed");
  const result = await modelTestingAnalysis(store(), config, snapshot, options);
  const allCandidates = surfaces.flatMap((id) => [`GAP-${id}-1`, `GAP-${id}-2`]);
  // Every candidate was decided exactly once across batches; nothing was silently dropped.
  expect(result.gaps.map(({ id }) => id).sort()).toEqual(surfaces.map((id) => `GAP-${id}-1`).sort());
  const artifacts = await store().listArtifacts();
  const read = async (kind: string) => JSON.parse((await store().readArtifact(artifacts.filter((entry) => entry.kind === kind).at(-1)?.artifactId ?? "")).content) as unknown;
  const selection = await read("testing-selection") as { selectedGapIds: string[]; rejected: { gapId: string }[] };
  expect([...selection.selectedGapIds, ...selection.rejected.map(({ gapId }) => gapId)].sort()).toEqual([...allCandidates].sort());
  const batches = await read("testing-selection-batches") as { candidateIds: string[] }[];
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flatMap(({ candidateIds }) => candidateIds).sort()).toEqual([...allCandidates].sort());
  expect(selections.some((ids) => ids.length === allCandidates.length)).toBe(false);
  // Each batch carries complete grounded surfaces for its own candidates plus the global index.
  expect(result.coverageComplete).toBe(true);
  if (scenario === "output-limited") {
    expect(artifacts.some(({ kind }) => kind.startsWith("model-output-limit-"))).toBe(true);
    expect(batches.every(({ candidateIds }) => candidateIds.length >= 1)).toBe(true);
  }
  activities.push(...selections.map((ids) => ids.join(",")));
  // Durable batches: resume repeats no completed model work, including after interruption.
  const before = calls;
  expect(await modelTestingAnalysis(store(), config, snapshot, options)).toEqual(result);
  expect(calls).toBe(before);
  // Only the interrupted request is re-sent; an output-limited request is retired, never repeated.
  const completedSelections = selections.length - (scenario === "interrupted" ? 1 : 0);
  expect(new Set(activities).size).toBe(completedSelections);
  expect(calls).toBe(1 + selections.length);
});

it.each(["inventory", "output-limited", "interrupted"] as const)("analyses risk for an oversized repository through bounded durable partitions: %s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "testing-risk-")); roots.push(root);
  // `inventory`: the mandatory path inventory alone cannot fit one request. Otherwise the full
  // request fits with excerpted source but its complete response exceeds the output ceiling.
  const count = scenario === "inventory" ? 64 : 6; const nested = ["inventory", "pressure", "module"].map((part) => `${part}-${"deliberately-long-directory-name-".repeat(6)}`).join("/");
  const directory = join(root, "src", ...nested.split("/"));
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `module-${String(index).padStart(3, "0")}.ts`; paths.push(`src/${nested}/${name}`);
    await writeFile(join(directory, name), `export const value${index} = ${index};\n` + (scenario === "inventory" ? "" : `// ${"production branch detail ".repeat(160)}\n`));
  }
  await writeFile(join(root, "app.unit.test.ts"), "test('unrelated', () => {});\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  const snapshot = await snapshotRepository(root, 400, { includeTestMetadata: true });
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "testing", scope: { kind: "repository" }, models: { analyst: { ...profile, capabilityTier: "frontier" } }, workflow: {
    testing: { mode: "plan", goal: "Prevent production failures", roles: { analyst: "analyst", planner: "analyst" } },
    modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { analyst: "primary" }, maximumOutputTokens: 2000, maximumContextTokens: 36_000, maximumTokens: 10_000_000, maximumRetries: 0, timeoutMs: 30_000,
      rateLimits: { [profile.provider]: { rpm: 100_000, tpm: 100_000_000, maxConcurrent: 4 } } },
  } });
  const partitions: { paths: string[]; repository: { path: string; content: string }[] }[] = [];
  let calls = 0; let full = 0; let interrupt = scenario === "interrupted";
  const options = { signal: new AbortController().signal, transport: { credential: () => "fixture-credential", client: { async send(request: HttpRequest) {
    calls += 1;
    const { system, input } = payload(request);
    const respond = (output: unknown) => ({ status: 200, headers: {}, body: { output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 30 } } });
    if (system.startsWith("Select Testing gaps")) return respond({ selectedGapIds: (input["candidates"] as { id: string }[]).map(({ id }) => id), rejected: [], limitations: [] });
    const scope = input["analysisScope"] as { assignedPaths: string[] } | undefined;
    if (scope === undefined) { full += 1; return { status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"summary":', usage: { input_tokens: 20, output_tokens: 2000 } } }; }
    partitions.push({ paths: scope.assignedPaths, repository: input["repository"] as { path: string; content: string }[] });
    if (interrupt && partitions.length === 2) { interrupt = false; throw new Error("FIXTURE_INTERRUPTED"); }
    const inventory = input["inventory"] as { sourceFiles: string[]; testFiles: string[] };
    // Every partition reports a surface named `shared`; separate partitions must not merge it away.
    const flagged = inventory.sourceFiles.filter((path) => paths.indexOf(path) % (scenario === "inventory" ? 16 : 2) === 0);
    return respond({ summary: `Partition ${scope.assignedPaths[0] ?? ""}`, reviewedSourcePaths: inventory.sourceFiles, reviewedTestPaths: inventory.testFiles, limitations: [],
      surfaces: flagged.map((path, index) => ({ id: index === 0 ? "shared" : path.slice(-6, -3), paths: [path], categories: ["unit"], severity: "high", failureModes: [`${path} regresses`],
        evidence: [{ path, startLine: 1, endLine: 1, text: `export const value${paths.indexOf(path)} = ${paths.indexOf(path)};` }] })) });
  } } } };
  const store = () => new RunStore(join(root, ".runs"), "run");
  if (scenario === "interrupted") await expect(modelTestingAnalysis(store(), config, snapshot, options)).rejects.toThrow("Provider openai failed");
  const result = await modelTestingAnalysis(store(), config, snapshot, options);
  const inventory = [...paths, "app.unit.test.ts"].sort();
  // The complete inventory could not be analysed in one request; the output-limited request is never repeated.
  expect(full).toBe(scenario === "inventory" ? 0 : 1);
  const artifacts = await store().listArtifacts();
  const read = async (kind: string) => JSON.parse((await store().readArtifact(artifacts.filter((entry) => entry.kind === kind).at(-1)?.artifactId ?? "")).content) as unknown;
  const batches = await read("testing-risk-batches") as { paths: string[] }[];
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flatMap((batch) => batch.paths).sort()).toEqual(inventory);
  // Every path was reviewed exactly once, and multi-path partitions carried each assigned file whole.
  expect([...result.risk.reviewedSourcePaths].sort()).toEqual(paths);
  expect(result.risk.reviewedTestPaths).toEqual(["app.unit.test.ts"]);
  expect(result.coverageComplete).toBe(true);
  for (const partition of partitions) expect(partition.repository.map(({ path, content }) => [path, content])).toEqual(partition.paths.map((path) => [path, snapshot.files.find((file) => file.path === path)?.lines.join("\n")]));
  const ids = result.risk.surfaces.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => id.startsWith("shared"))).toHaveLength(batches.filter((batch) => batch.paths.some((path) => paths.indexOf(path) % (scenario === "inventory" ? 16 : 2) === 0)).length);
  // Resume repeats no completed model work; only the interrupted partition was re-sent.
  const before = calls;
  expect(await modelTestingAnalysis(store(), config, snapshot, options)).toEqual(result);
  expect(calls).toBe(before);
  expect(partitions).toHaveLength(batches.length + (scenario === "interrupted" ? 1 : 0));
});

it.each(["complete", "interrupted", "outline-limited"] as const)("plans an oversized selected-gap set through one staged durable Testing planner: %s", async (scenario) => {
  const interrupted = scenario === "interrupted";
  const root = await mkdtemp(join(tmpdir(), "testing-planner-")); roots.push(root);
  const surfaces = ["auth", "session", "billing", "export"];
  await writeFile(join(root, "app.ts"), surfaces.map((id) => `export const ${id} = false;`).join("\n") + "\n");
  await writeFile(join(root, "app.unit.test.ts"), "test('unrelated', () => {});\n");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  const snapshot = await snapshotRepository(root, 10, { includeTestMetadata: true });
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "testing", scope: { kind: "repository" },
    models: { analyst: { ...profile, capabilityTier: "frontier" }, planner: { ...profile, independenceGroup: "planner", limits: { ...profile.limits, contextTokens: 70_000 } } }, workflow: {
      testing: { mode: "plan", goal: "Prevent production failures", roles: { analyst: "analyst", planner: "planner" } },
      modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
        modelEndpoints: { analyst: "primary", planner: "primary" }, maximumOutputTokens: 2000, maximumTokens: 10_000_000, maximumRetries: 0, timeoutMs: 30_000,
        rateLimits: { [profile.provider]: { rpm: 1000, tpm: 10_000_000, maxConcurrent: 4 } } },
    } });
  const risk = { summary: "Independent production surfaces", reviewedSourcePaths: ["app.ts"], reviewedTestPaths: ["app.unit.test.ts"], limitations: [],
    surfaces: surfaces.map((id, index) => ({ id, paths: ["app.ts"], categories: ["unit"], severity: "high",
      failureModes: [`${id} regression: ` + "silently accepts an invalid state transition. ".repeat(90)],
      evidence: [{ path: "app.ts", startLine: index + 1, endLine: index + 1, text: `export const ${id} = false;` }] })) };
  const gapIds = surfaces.map((id) => `GAP-${id}-1`);
  const template = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const base = template.tasks[0]; const route = template.routingRecommendations[0];
  if (base === undefined || route === undefined) throw new Error("FIXTURE_PLAN_ABSENT");
  const tasks = gapIds.map((gapId, index) => ({ ...base, id: `TASK-00${index + 1}`, addresses: { issues: [], validation: [`VAL-00${index + 1}`], requirements: [gapId] },
    scope: { ...base.scope, likelyFiles: ["app.unit.test.ts"] }, verification: { ...base.verification, commands: [{ command: "npm run test", expectedExitCode: 0, executionPolicy: "derived_repository_script" as const }] } }));
  const plan: PlanIR = { ...template, mode: "testing", acceptedIssueIds: [], tasks, taskGraph: [], unresolvedQuestions: [],
    premiseReport: { status: "unavailable", interpretation: "smoke_test_only_not_proof", limitations: ["real_model_premise_requires_ground_truth_evaluation"] },
    validationContract: { schemaVersion: 1, validation: gapIds.map((id, index) => ({ id: `VAL-00${index + 1}`, assertion: `${id} is protected`, evidence: ["regression test"] })) },
    traceability: { issueToValidation: [], requirementLinks: { schemaVersion: 1, links: gapIds.map((requirementId, index) => ({ requirementId, taskIds: [`TASK-00${index + 1}`], validationIds: [`VAL-00${index + 1}`] })) } },
    routingRecommendations: tasks.map(({ id }) => ({ ...route, taskId: id })) };
  const calls: { stage: string; key: string; input: Record<string, unknown> }[] = [];
  const truncated = (stage: string, system: string, input: Record<string, unknown>) => {
    calls.push({ stage, key: createHash("sha256").update(system).update(JSON.stringify(input)).digest("hex"), input });
    return { status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"schemaVersion":', usage: { input_tokens: 20, output_tokens: 2000 } } };
  };
  let failNext = interrupted;
  const transport = { credential: () => "fixture-credential", client: { async send(request: HttpRequest) {
    const { system, input } = payload(request);
    let stage: string; let output: unknown;
    if (system.startsWith("Identify production-risk")) { stage = "risk"; output = risk; }
    else if (system.startsWith("Select Testing gaps")) { stage = "selection"; output = { selectedGapIds: (input["candidates"] as { id: string }[]).map(({ id }) => id), rejected: [], limitations: [] }; }
    else if (system.startsWith("Create one coherent Testing")) { stage = "planner-full"; output = plan; }
    else if (system.startsWith("Read the complete requirement records")) {
      stage = "planner-brief";
      output = { issues: (input["planningScope"] as { recordIds: string[] }).recordIds.map((issueId) => ({ issueId, summary: `Brief ${issueId}`, affectedPaths: ["app.unit.test.ts"], behavioralAssertions: [`${issueId} protected`], integrationConstraints: [], unresolvedQuestions: [] })) };
    } else if (system.startsWith("Produce the single global testing plan outline")) {
      stage = "planner-outline"; output = { ...plan, tasks: tasks.map(taskOutline) };
      // The complete outline exceeds the output ceiling; a hierarchical outline must replace it.
      if (scenario === "outline-limited") return truncated(stage, system, input);
    } else if (system.startsWith("Produce one section of the single global testing plan outline")) {
      stage = "planner-section"; const recordIds = (input["outlineScope"] as { recordIds: string[] }).recordIds;
      if (recordIds.length > 2) return truncated(stage, system, input);
      const local = recordIds.filter((id) => gapIds.includes(id));
      const sectionTasks = local.map((gapId, index) => ({ ...taskOutline(tasks[0] ?? base), id: `TASK-00${index + 1}`, title: `Protect ${gapId}`, addresses: { issues: [], validation: [`VAL-00${index + 1}`], requirements: [gapId] } }));
      output = { ...plan, id: `section-${recordIds.join("-")}`, tasks: sectionTasks, rolloutConcerns: [`Roll out ${recordIds.join(",")}`],
        validationContract: { schemaVersion: 1, validation: local.map((id, index) => ({ id: `VAL-00${index + 1}`, assertion: `${id} is protected`, evidence: ["regression test"] })) },
        traceability: { issueToValidation: [], requirementLinks: { schemaVersion: 1, links: local.map((requirementId, index) => ({ requirementId, taskIds: [`TASK-00${index + 1}`], validationIds: [`VAL-00${index + 1}`] })) } },
        routingRecommendations: sectionTasks.map(({ id }) => ({ ...route, taskId: id })) };
    } else if (system.startsWith("Write the header of the single global testing plan outline")) { stage = "planner-header"; output = { id: "testing-plan", title: "Testing plan", reasoningOutcome: "Protect every selected gap", implementationStrategy: ["One regression test per gap"], dependencies: [], rolloutConcerns: [], migrationConcerns: [] }; }
    else if (system.startsWith("Link dependencies across")) { stage = "planner-links"; output = { dependencies: [] }; }
    else if (system.startsWith("Expand the selected task")) {
      stage = "planner-expand"; const selected = input["selectedTask"] as PlanIR["tasks"][number];
      if (failNext && selected.id === "TASK-003") { failNext = false; calls.push({ stage, key: "interrupted", input }); throw new Error("FIXTURE_EXPANSION_INTERRUPTED"); }
      output = { task: { ...tasks[0], ...selected }, unresolvedQuestions: [] };
    } else throw new Error(`UNEXPECTED_TESTING_PROMPT:${system.slice(0, 80)}`);
    calls.push({ stage, key: createHash("sha256").update(system).update(JSON.stringify(input)).digest("hex"), input });
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } };
  const pipeline = () => new TestingPipeline(new RunStore(join(root, ".runs"), "run"), config, snapshot, transport);
  if (interrupted) await expect(pipeline().run(new AbortController().signal)).rejects.toThrow("Provider openai failed");
  const outcome = await pipeline().run(new AbortController().signal);
  expect(outcome).toMatchObject({ passed: true, reasons: [], selectedGaps: 4, testsExecuted: false });
  const stages = calls.map(({ stage }) => stage);
  // The complete mandatory planner context could not fit; no full-plan request was made.
  expect(stages).not.toContain("planner-full");
  expect(stages.filter((stage) => stage === "planner-outline")).toHaveLength(1);
  expect(stages.filter((stage) => stage === "planner-expand")).toHaveLength(interrupted ? 5 : 4);
  if (scenario === "outline-limited") {
    // Output-limited sections were retired and split until every section fit one response.
    const sections = calls.filter(({ stage }) => stage === "planner-section").map(({ input }) => (input["outlineScope"] as { recordIds: string[] }).recordIds);
    const completed = sections.filter((ids) => ids.length <= 2);
    expect(completed.length).toBeGreaterThan(1);
    expect(completed.flat().sort()).toEqual(["TEST_SCOPE", ...gapIds].sort());
    expect(stages.filter((stage) => stage === "planner-header")).toHaveLength(1);
    expect(stages.filter((stage) => stage === "planner-links")).toHaveLength(1);
  }
  const keys = calls.filter(({ key }) => key !== "interrupted").map(({ key }) => key);
  expect(new Set(keys).size).toBe(keys.length);
  // Each selected gap's complete record and exact risk evidence reached a brief and its expansion.
  for (const [index, gapId] of gapIds.entries()) {
    const failureMode = risk.surfaces[index]?.failureModes[0] ?? "missing";
    for (const phase of ["planner-brief", "planner-expand"]) expect(calls.some(({ stage, input }) => stage === phase && JSON.stringify(input).includes(gapId) && JSON.stringify(input).includes(failureMode))).toBe(true);
  }
  const store = new RunStore(join(root, ".runs"), "run");
  const saved = (await store.listArtifacts()).filter(({ kind }) => kind === "plan-ir").at(-1);
  const final = planIRSchema.parse(JSON.parse((await store.readArtifact(saved?.artifactId ?? "")).content));
  expect(final.traceability.requirementLinks.links.map(({ requirementId }) => requirementId).sort()).toEqual([...gapIds].sort());
  expect(final.tasks.map(({ id }) => id)).toEqual(["TASK-001", "TASK-002", "TASK-003", "TASK-004"]);
  if (scenario === "outline-limited") expect(final.rolloutConcerns).toHaveLength(3);
  // Re-running the completed plan repeats no model work.
  const before = calls.length;
  expect(await pipeline().run(new AbortController().signal)).toEqual(outcome);
  expect(calls).toHaveLength(before);
});
