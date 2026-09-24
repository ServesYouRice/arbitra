import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import type { HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import { Orchestrator } from "../src/orchestrator.js";
import { controlPlaneCore } from "../src/control-plane-core.js";
import { taskOutline } from "../src/planner-context.js";
import type { PlannerBrief, PlannerTaskOutline } from "@arbitra/schemas/planner-composition.js";
import type { TestSandbox } from "../src/test-sandbox.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { revision?: "resolved" | "still_blocking" | "invalid_traceability" | "missing_resolution"; largePlannerContext?: boolean; largeCriticContext?: boolean; largePeerContext?: boolean; lowRisk?: boolean; structuralReview?: boolean; conflictingReview?: boolean; conflictResolution?: "retain_original" | "proposal-1"; ambiguousClustering?: boolean; oversizedRepository?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "arbitra-model-run-")); directories.push(directory);
  const manyIssues = options.largePeerContext === true || options.largePlannerContext === true;
  await writeFile(join(directory, "a.ts"), "const value = null;\n".repeat(manyIssues ? 4 : options.ambiguousClustering === true ? 3 : 1), "utf8");
  if (options.oversizedRepository === true) await writeFile(join(directory, "large.ts"), "// unrelated source\n".repeat(12_000), "utf8");
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const template = example.models["auditor-a"];
  if (template === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const planTemplate = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  if (options.largeCriticContext === true) {
    const task = planTemplate.tasks[0]; const routing = planTemplate.routingRecommendations[0];
    if (task === undefined || routing === undefined) throw new Error("FIXTURE_PLAN_ABSENT");
    planTemplate.tasks = Array.from({ length: 4 }, (_, index) => ({ ...task, id: `TASK-${index}`, implementationGuidance: ["Review this implementation detail. ".repeat(800)] }));
    planTemplate.routingRecommendations = planTemplate.tasks.map(({ id }) => ({ ...routing, taskId: id }));
  }
  const providers = ["openai", "anthropic", "google"];
  const transports = ["openai-responses", "anthropic-messages", "gemini-native"];
  const ids = ["auditor-a", "auditor-b", "auditor-c"];
  const config = runConfigSchema.parse({ ...example, models: Object.fromEntries(ids.map((id, index) => [id, { ...template, provider: providers[index], transport: transports[index], independenceGroup: id, modelId: id }])),
    workflow: { preset: "audit-deep", modelExecution: {
      endpoints: ids.map((id, index) => ({ id, providerId: providers[index], transport: transports[index], endpoint: `https://${id}.example/v1`, apiKeyEnvVar: "FIXTURE_KEY" })),
      modelEndpoints: Object.fromEntries(ids.map((id) => [id, id])), roles: { planner: "auditor-a", verifier: "auditor-b", critic: "auditor-c" },
      maximumClusteringPairs: manyIssues ? 0 : 20, maximumOutputTokens: 2_000, maximumTokens: manyIssues || options.largeCriticContext === true && options.revision !== undefined ? 20_000_000 : 1_000_000, timeoutMs: 30_000, maximumRetries: 0,
      rateLimits: Object.fromEntries(providers.map((id) => [id, { rpm: 1000, tpm: 10_000_000, maxConcurrent: 4 }])),
    } },
  });
  if (options.largePlannerContext === true) {
    config.models["planner-model"] = { ...template, modelId: "planner-model", limits: { ...template.limits, contextTokens: 100_000 } };
    const execution = config.workflow["modelExecution"] as { modelEndpoints: Record<string, string>; roles: { planner: string } };
    execution.modelEndpoints["planner-model"] = "auditor-a"; execution.roles.planner = "planner-model";
  }
  const requests: { stage: string; url: string }[] = [];
  let failVerification = false;
  let failCritic = false;
  let failExpansion = false;
  let failRevisionPatch = false;
  let blockDiscovery: (() => void) | undefined;
  const send = async (request: HttpRequest): Promise<HttpResponse> => {
    const body = request.body as { input?: { role: string; content: string }[]; system?: string; messages?: { content: string }[]; systemInstruction?: { parts: { text: string }[] }; contents?: { parts: { text: string }[] }[] };
    let system = body.input?.find(({ role }) => role === "system")?.content ?? body.system ?? body.systemInstruction?.parts[0]?.text ?? "";
    let user = body.input?.find(({ role }) => role === "user")?.content ?? body.messages?.[0]?.content ?? body.contents?.[0]?.parts[0]?.text ?? "{}";
    if (user.startsWith('{"layer":"locked"')) {
      const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
      system = layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "";
      const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
      const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
      user = content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    }
    let output: unknown;
    if (system.startsWith("Audit the supplied")) {
      requests.push({ stage: "discovery", url: request.url });
      if (blockDiscovery !== undefined) { blockDiscovery(); return new Promise(() => {}); }
      const auditorId = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(system)?.[1];
      const line = options.ambiguousClustering === true ? ids.indexOf(auditorId ?? "") + 1 : 1;
      output = { findings: [{ schemaVersion: 1, sourceFindingId: `${auditorId}/1`, category: "CORRECTNESS", title: "Null value", severity: options.lowRisk === true ? "low" : "high", status: "needs_verification", confidence: 0.5, productionBlocker: false,
        locations: [{ id: `${auditorId}-L1`, path: "a.ts", startLine: line, endLine: line }], evidence: [{ id: `${auditorId}-E1`, text: "const value = null;", locationIds: [`${auditorId}-L1`] }],
        problem: "Fixture null claim", recommendedFix: "Check null", productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [] }], truncated: false, unexaminedDueToBudget: [], limitations: [] };
      if (manyIssues) {
        const envelope = output as { findings: Record<string, unknown>[] };
        const original = envelope.findings[0];
        envelope.findings = Array.from({ length: 4 }, (_, index) => ({ ...original, sourceFindingId: `${auditorId}/${index + 1}`, title: `Null claim ${index}`, recommendedFix: `${index}: ` + "Check guard. ".repeat(options.largePeerContext === true ? 750 : 1), locations: [{ id: `${auditorId}-L${index}`, path: "a.ts", startLine: index + 1, endLine: index + 1 }], evidence: [{ id: `${auditorId}-E${index}`, text: "const value = null;", locationIds: [`${auditorId}-L${index}`] }] }));
      }
    } else if (system.startsWith("Compare the supplied candidate pair")) {
      requests.push({ stage: "merge-check", url: request.url });
      expect(user).not.toMatch(/auditor-[abc]/u);
      output = { operations: [], findings: [], locations: [] };
    } else if (system.startsWith("Classify the relationship")) {
      requests.push({ stage: "clustering", url: request.url });
      expect(user).not.toMatch(/auditor-[abc]/u);
      output = { relationship: "same_root_cause", rationale: "Fixture shared null source" };
    } else if (system.startsWith("Resolve the supplied")) {
      requests.push({ stage: "conflict", url: request.url });
      expect(user).not.toMatch(/auditor-[abc]/u);
      const input = JSON.parse(user) as { candidates: Record<string, { sources: { evidence: { id: string }[] }[] }> };
      output = { selection: options.conflictResolution ?? "unresolved", evidenceIds: Object.values(input.candidates).flatMap(({ sources }) => sources.flatMap(({ evidence }) => evidence.map(({ id }) => id))), rationale: "Fixture resolution based on supplied source" };
    } else if (system.startsWith("Review every")) {
      requests.push({ stage: "review", url: request.url });
      const input = JSON.parse(user) as { round: number; candidates: Record<string, { candidateId: string; sources: { findingRef: string; evidence: { id: string }[] }[] }> };
      expect(user).not.toMatch(/auditor-[abc]/u);
      output = { operations: Object.values(input.candidates).map(({ candidateId, sources }, index) => ({ operationId: `new:vote-${index}`, candidateId, authorId: "self", round: input.round, type: request.url.includes("auditor-b") ? "reject" : "accept", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)), reason: "Fixture review of supplied evidence" })), locations: [], findings: [] };
      if (options.largePlannerContext === true && input.round === 1 && request.url.includes("auditor-a")) {
        (output as { operations: unknown[] }).operations.push(...Object.values(input.candidates).map(({ candidateId, sources }, index) => ({ operationId: `new:supplement-${index}`, candidateId, authorId: "self", round: 1, type: "supplement_remediation", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)), text: `Original detail ${candidateId}: ` + "Preserve guard. ".repeat(1200) })));
      }
      if ((options.structuralReview === true || options.conflictingReview === true) && input.round === 1 && (request.url.includes("auditor-a") || options.conflictingReview === true && request.url.includes("auditor-b"))) {
        const candidate = Object.values(input.candidates)[0];
        if (candidate === undefined) throw new Error("FIXTURE_CANDIDATE_ABSENT");
        const base = { candidateId: candidate.candidateId, authorId: "self", round: 1, citedEvidenceIds: candidate.sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)) };
        output = { operations: [
          { ...base, operationId: "new:counter", type: "add_counter_evidence", citedEvidenceIds: ["new:counter-evidence"], evidence: { id: "new:counter-evidence", text: "const value = null;", locationIds: ["new:counter-location"] } },
          { ...base, operationId: "new:advice", type: "supplement_verification", text: "Exercise both branches." },
          { ...base, operationId: "new:split", type: "split", reason: "Separate causes", candidates: ["left", "right"].map((name) => ({ candidateId: `new:${name}`, title: name, description: "Separate source-backed claim", sourceFindingIds: candidate.sources.map(({ findingRef }) => findingRef), severity: "high", blocker: false })) },
        ], locations: [{ id: "new:counter-location", path: "a.ts", startLine: 1, endLine: 1 }], findings: [] };
      }
    } else if (system.startsWith("Answer the single")) {
      requests.push({ stage: "verification", url: request.url });
      if (failVerification) return { status: 503, headers: {}, body: {} };
      const input = JSON.parse(user) as { request: { context: { citedContext: { evidenceId: string }[] } } };
      output = { outcome: "CONFIRMED", evidenceIds: input.request.context.citedContext.map(({ evidenceId }) => evidenceId), confidence: 0.8 };
    } else if (system.startsWith("Read the complete accepted issues")) {
      requests.push({ stage: "planner-brief", url: request.url });
      const input = JSON.parse(user) as { canonicalIssues: { candidateId: string; remediationSupplements: string[] }[] };
      expect(input.canonicalIssues.every(({ remediationSupplements }) => remediationSupplements[0]?.includes("Original detail"))).toBe(true);
      output = { issues: input.canonicalIssues.map(({ candidateId }) => ({ issueId: candidateId, summary: "Null source claim with detailed guard constraints", affectedPaths: ["a.ts"], behavioralAssertions: ["Guard null values"], integrationConstraints: ["Preserve existing behavior"], unresolvedQuestions: [] })) };
    } else if (system.startsWith("Produce the single global plan outline")) {
      requests.push({ stage: "planner-outline", url: request.url });
      const input = JSON.parse(user) as { issueBriefs: PlannerBrief["issues"]; acceptedIssueIds: string[]; premiseReport: unknown };
      const templateTask = planTemplate.tasks[0]; if (templateTask === undefined) throw new Error("FIXTURE_TASK_ABSENT");
      const tasks = input.acceptedIssueIds.map((issueId, index) => ({ ...taskOutline(templateTask), id: `TASK-${index + 1}`, addresses: { ...templateTask.addresses, issues: [issueId] }, dependencies: { dependsOn: index === 0 ? [] : [`TASK-${index}`], blocks: [], conflictsWith: [] } }));
      output = { ...planTemplate, acceptedIssueIds: input.acceptedIssueIds, premiseReport: input.premiseReport, tasks, taskGraph: tasks.slice(1).map(({ id }, index) => ({ from: tasks[index]?.id, to: id })),
        traceability: { ...planTemplate.traceability, issueToValidation: input.acceptedIssueIds.map((issueId) => ({ issueId, validationIds: ["VAL-001"] })) },
        routingRecommendations: tasks.map(({ id, routing }) => ({ taskId: id, capability: routing.capability, effort: routing.effort, reason: routing.reason })),
        unresolvedQuestions: input.issueBriefs.flatMap(({ unresolvedQuestions }) => unresolvedQuestions),
      };
    } else if (system.startsWith("Expand the selected task")) {
      requests.push({ stage: "planner-expand", url: request.url });
      const input = JSON.parse(user) as { selectedTask: PlannerTaskOutline; canonicalIssues: { candidateId: string; remediationSupplements: string[] }[] };
      if (failExpansion && input.selectedTask.id === "TASK-2") return { status: 503, headers: {}, body: {} };
      expect(input.canonicalIssues).toHaveLength(1);
      expect(input.canonicalIssues[0]?.remediationSupplements[0]).toContain("Original detail");
      output = { task: { ...planTemplate.tasks[0], ...input.selectedTask }, unresolvedQuestions: input.selectedTask.id === "TASK-4" ? [{ id: "Q-1", question: "Integration needs operator decision", blocking: true, blastRadius: "high" }] : [] };
    } else if (system.startsWith("Produce a complete")) {
      requests.push({ stage: "planner", url: request.url });
      const input = JSON.parse(user) as { canonicalIssues: { candidateId: string }[]; premiseReport: unknown };
      const acceptedIssueIds = input.canonicalIssues.map(({ candidateId }) => candidateId);
      output = { ...planTemplate, acceptedIssueIds, tasks: planTemplate.tasks.map((task) => ({ ...task, addresses: { ...task.addresses, issues: acceptedIssueIds } })),
        traceability: { ...planTemplate.traceability, issueToValidation: acceptedIssueIds.map((issueId) => ({ issueId, validationIds: ["VAL-001"] })) }, premiseReport: input.premiseReport };
    } else if (system.startsWith("Apply one atomic revision")) {
      requests.push({ stage: "revision-patch", url: request.url });
      if (failRevisionPatch && requests.filter(({ stage }) => stage === "revision-patch").length === 2) return { status: 503, headers: {}, body: {} };
      const input = JSON.parse(user) as { globalPlan: Omit<ReturnType<typeof planIRSchema.parse>, "tasks">; selectedTasks: ReturnType<typeof planIRSchema.parse>["tasks"]; critique: { id: string } };
      expect(input.selectedTasks.length).toBeGreaterThan(0);
      expect(input.selectedTasks.every(({ implementationGuidance }) => implementationGuidance[0]?.startsWith("Review this implementation detail."))).toBe(true);
      output = { critiqueItemId: input.critique.id, resolution: "Added the required acceptance assertion and retained original implementation detail", globalPlan: { ...input.globalPlan, title: "Revised plan" }, tasks: input.selectedTasks.map((task) => ({ ...task, acceptanceCriteria: [...task.acceptanceCriteria, `Resolved ${input.critique.id}`] })), retiredTaskIds: [], lineage: input.selectedTasks.map(({ id }) => ({ previousTaskId: id, nextTaskIds: [id], rationale: "Same behavioral task with improved acceptance" })) };
    } else if (system.startsWith("Revise the supplied")) {
      requests.push({ stage: "revision", url: request.url });
      const input = JSON.parse(user) as { originalPlan: ReturnType<typeof planIRSchema.parse>; blockingCritique: { id: string }[] };
      output = { plan: { ...input.originalPlan, title: "Revised plan", ...(options.revision === "invalid_traceability" ? { acceptedIssueIds: [] } : {}) }, resolutions: options.revision === "missing_resolution" ? [] : input.blockingCritique.map(({ id }) => ({ critiqueItemId: id, resolution: "Added the requested validation" })) };
    } else if (system.startsWith("Critique the plan")) {
      requests.push({ stage: "critic", url: request.url });
      if (failCritic && requests.filter(({ stage }) => stage === "critic").length === 2) return { status: 503, headers: {}, body: {} };
      const input = JSON.parse(user) as { plan: { title: string; tasks: { id: string }[] }; reviewScope?: { globalIndex: { tasks: { id: string }[] } } };
      const taskId = input.plan.tasks[0]?.id ?? input.reviewScope?.globalIndex.tasks[0]?.id;
      const blocking = options.revision !== undefined && (input.plan.title !== "Revised plan" || options.revision === "still_blocking");
      output = { summary: "Fixture critique", items: options.largeCriticContext === true || blocking ? [{ id: "local-1", category: "weak_verification", blocking, summary: "Fixture mapped feedback", taskIds: [taskId], issueIds: [] }] : [] };
    } else throw new Error("UNKNOWN_FIXTURE_STAGE");
    const text = JSON.stringify(output);
    const response = request.url.includes("auditor-b") ? { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } }
      : request.url.includes("auditor-c") ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }
      : { output_text: text, usage: { input_tokens: 10, output_tokens: 20 } };
    return { status: 200, headers: {}, body: response };
  };
  const create = (testSandbox?: TestSandbox) => new Orchestrator({ repository: directory, stateDirectory: join(directory, ".runs"), providerOptions: { client: { send }, credential: () => "fixture-credential" }, ...(testSandbox === undefined ? {} : { testSandbox }) });
  return { create, config, requests, failRevisionPatch: (value: boolean) => { failRevisionPatch = value; }, failExpansion: (value: boolean) => { failExpansion = value; }, failCritic: (value: boolean) => { failCritic = value; }, failVerification: (value: boolean) => { failVerification = value; }, blockDiscovery: (callback: () => void) => { blockDiscovery = callback; } };
}

describe("composed model audits", () => {
  it("does not resolve a disputed claim from a successful test exit alone", async () => {
    const setup = await fixture(); let calls = 0;
    const image = `local/node@sha256:${"a".repeat(64)}`;
    setup.config.verification = { maxModelQuestionsPerRound: 0, execution: { driver: "docker", image, checks: [{ id: "guard", sourcePaths: ["a.ts"], executable: "/bin/node", arguments: ["a.ts"] }] } };
    const sandbox: TestSandbox = { async recover() {}, async run() {
      calls += 1;
      return { driver: "docker", image, checkId: "guard", isolation: "read_only_snapshot_no_network", status: "exited", cleanupCompleted: true, exitCode: 0, stdout: "pass", stderr: "", stopped: null };
    } };
    const core = setup.create(sandbox); const run = await core.run(setup.config);
    expect(calls).toBe(1);
    const artifact = (await core.artifacts(run.runId)).find(({ kind }) => kind === "verification-metrics");
    if (artifact === undefined) throw new Error("METRICS_ABSENT");
    expect(JSON.parse((await core.artifact(run.runId, artifact.artifactId) as { content: string }).content)).toMatchObject({ modelCalls: 0, resolvedDisputes: 0 });
  });
  it("publishes executed checks and reuses them after a failed model verification", async () => {
    const setup = await fixture(); let calls = 0;
    const image = `local/node@sha256:${"a".repeat(64)}`;
    setup.config.verification["execution"] = { driver: "docker", image, maximumRuns: 1, checks: [{ id: "guard", sourcePaths: ["a.ts"], executable: "/bin/node", arguments: ["a.ts"] }] };
    const sandbox: TestSandbox = { async recover() { throw new Error("UNEXPECTED_RECOVERY"); }, async run() {
      calls += 1;
      return { driver: "docker", image, checkId: "guard", isolation: "read_only_snapshot_no_network", status: "exited", cleanupCompleted: true, exitCode: 0, stdout: "fixture test output", stderr: "", stopped: null };
    } };
    setup.failVerification(true);
    const core = setup.create(sandbox); const run = await core.run(setup.config);
    expect(run.state).toBe("FAILED"); expect(calls).toBe(1);
    setup.failVerification(false);
    const resumed = setup.create(sandbox); await resumed.resume(run.runId);
    expect((await resumed.wait(run.runId)).state).toBe("COMPLETED"); expect(calls).toBe(1);
    const artifacts = await resumed.artifacts(run.runId);
    const checks = artifacts.find(({ kind }) => kind.startsWith("verification-checks-"));
    if (checks === undefined) throw new Error("CHECKS_ABSENT");
    expect(JSON.parse((await resumed.artifact(run.runId, checks.artifactId) as { content: string }).content)).toMatchObject({ records: [{ state: "completed", result: { stdout: "fixture test output" } }] });
    const prompts = await Promise.all(artifacts.filter(({ kind }) => kind.startsWith("compiled-prompt-")).map(({ artifactId }) => resumed.artifact(run.runId, artifactId)));
    expect(prompts.some((artifact) => (artifact as { content: string }).content.includes("fixture test output"))).toBe(true);
  });
  it.each(["resolved", "still_blocking"] as const)("resumes oversized planner revisions and rechecks every critique claim: %s", async (revision) => {
    const { create, config, requests, failRevisionPatch } = await fixture({ largeCriticContext: true, revision });
    failRevisionPatch(true);
    const initial = create(); const run = await initial.run(config);
    const events = []; for await (const event of initial.events(run.runId)) events.push(event);
    expect(run.state, JSON.stringify(events.at(-1))).toBe("FAILED");
    expect(requests.filter(({ stage }) => stage === "revision-patch"), JSON.stringify(events)).toHaveLength(2);
    failRevisionPatch(false);
    const resumed = create(); await resumed.resume(run.runId);
    const result = await resumed.wait(run.runId);
    const resumedEvents = []; for await (const event of resumed.events(run.runId)) resumedEvents.push(event);
    expect(result.state, JSON.stringify(resumedEvents.at(-1))).toBe("COMPLETED");
    const artifacts = await resumed.artifacts(run.runId);
    const read = async (kind: string) => {
      const descriptor = artifacts.find((artifact) => artifact.kind === kind); if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`);
      return JSON.parse((await resumed.artifact(run.runId, descriptor.artifactId) as { content: string }).content);
    };
    const original = await read("critic-initial-feedback") as { items: { id: string }[] };
    const revised = await read("plan-revision") as { revisionCalls: number; resolutions: { critiqueItemId: string }[]; plan: ReturnType<typeof planIRSchema.parse> };
    expect(revised.revisionCalls).toBe(1);
    expect(revised.resolutions.map(({ critiqueItemId }) => critiqueItemId)).toEqual(original.items.map(({ id }) => id));
    expect(requests.filter(({ stage }) => stage === "revision-patch")).toHaveLength(original.items.length + 1);
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(0);
    expect(revised.plan.tasks).toHaveLength(4);
    expect(revised.plan.tasks.every(({ implementationGuidance }) => implementationGuidance[0]?.startsWith("Review this implementation detail."))).toBe(true);
    const batches = await read("critic-revision-context-batches") as { kind: string; recordIds: string[] }[];
    const primary = batches.filter(({ kind }) => kind === "review").flatMap(({ recordIds }) => recordIds);
    expect(primary.filter((id) => id.startsWith("revision:")).sort()).toEqual(original.items.map(({ id }) => `revision:${id}`).sort());
    for (const { id } of original.items) for (const task of revised.plan.tasks) expect(batches.some(({ recordIds }) => recordIds.includes(`revision:${id}`) && recordIds.includes(`task:${task.id}`))).toBe(true);
    expect((await resumed.gate(run.runId)).reasons.includes("blocking_critic_feedback")).toBe(revision === "still_blocking");
  }, 120_000); // ~32 s per case alone (beta and this branch); exceeded 60 s under full-suite contention

  it("plans oversized accepted issues using one global outline and resumes completed expansions", async () => {
    const { create, config, requests, failExpansion } = await fixture({ largePlannerContext: true });
    failExpansion(true);
    const initial = create(); const run = await initial.run(config);
    const events = []; for await (const event of initial.events(run.runId)) events.push(event);
    expect(run.state, JSON.stringify(events.at(-1))).toBe("FAILED");
    expect(requests.filter(({ stage }) => stage === "planner-outline")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "planner-expand")).toHaveLength(2);
    const briefCount = requests.filter(({ stage }) => stage === "planner-brief").length;
    expect(briefCount).toBeGreaterThan(1);
    failExpansion(false);
    const resumed = create(); await resumed.resume(run.runId);
    const result = await resumed.wait(run.runId);
    const resumedEvents = []; for await (const event of resumed.events(run.runId)) resumedEvents.push(event);
    expect(result.state, JSON.stringify(resumedEvents.at(-1))).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "planner-brief")).toHaveLength(briefCount);
    expect(requests.filter(({ stage }) => stage === "planner-outline")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "planner-expand")).toHaveLength(5);
    expect(requests.filter(({ stage }) => stage === "planner")).toHaveLength(0);
    expect(requests.some(({ stage }) => stage === "critic")).toBe(true);
    const descriptor = (await resumed.artifacts(run.runId)).find(({ kind }) => kind === "plan-ir");
    if (descriptor === undefined) throw new Error("PLAN_ABSENT");
    const plan = planIRSchema.parse(JSON.parse((await resumed.artifact(run.runId, descriptor.artifactId) as { content: string }).content));
    expect(plan.acceptedIssueIds).toHaveLength(4); expect(plan.tasks).toHaveLength(4); expect(plan.taskGraph).toHaveLength(3);
    expect(plan.unresolvedQuestions).toMatchObject([{ id: "expansion-TASK-4/Q-1", blocking: true }]);
    expect((await resumed.gate(run.runId)).reasons).toContain("blocking_plan_questions");
    expect((await resumed.modelTraces(run.runId)).filter(({ nodeId }) => nodeId === "planner").every(({ modelId }) => modelId === "planner-model")).toBe(true);
    const artifacts = await resumed.artifacts(run.runId);
    const countArtifact = artifacts.find(({ kind }) => kind === "planner-result");
    if (countArtifact === undefined) throw new Error("PLANNER_RESULT_ABSENT");
    expect(JSON.parse((await resumed.artifact(run.runId, countArtifact.artifactId) as { content: string }).content)).toEqual({ logicalModelCalls: briefCount + 5 });
    for (const artifact of artifacts.filter(({ kind }) => kind.startsWith("model-context-"))) {
      const context = JSON.parse((await resumed.artifact(run.runId, artifact.artifactId) as { content: string }).content) as { activityId: string; estimatedTokens: number; maximumEstimatedTokens: number };
      expect(context.estimatedTokens).toBeLessThanOrEqual(context.maximumEstimatedTokens);
    }
  }, 60_000);

  it("reports recorded model activity without inventing ground-truth scores or cost", async () => {
    const { create, config, requests } = await fixture();
    const orchestrator = create(); const run = await orchestrator.run(config);
    expect(run.state).toBe("COMPLETED");
    const core = controlPlaneCore(orchestrator);
    const metrics = await core.evaluation.metrics(run.runId);
    expect(metrics.denominator).toEqual({ activityCount: requests.length, auditorCount: 0, groundTruthAvailable: false });
    expect(metrics.rows.length).toBeGreaterThan(3);
    expect(metrics.rows.every(({ protocolIdentity, harnessIdentity }) => protocolIdentity !== undefined && harnessIdentity !== undefined)).toBe(true);
    expect(metrics.totalCostUsd).toBeNull(); expect(metrics.consensusPrecision).toBeNull();
    expect(metrics.inputTokens).toBe(requests.length * 10);
    expect(metrics.outputTokens).toBe(requests.length * 20);
    expect(metrics.verificationResolutionRate).toBe(1);
    const browser = controlPlaneCore(create()).traces;
    const traces = await browser.list(run.runId, { limit: 100 });
    expect(traces.total).toBe(requests.length);
    expect(traces.facets.modelIds).toEqual(["auditor-a", "auditor-b", "auditor-c"]);
    for (const { traceId, trace } of traces.entries) {
      expect(await browser.detail(run.runId, traceId)).toEqual({ traceId, trace });
      const input = await browser.artifact(run.runId, traceId, "input-0");
      expect(JSON.parse(input.content)).toMatchObject({ activityId: trace.activityId });
      const output = await browser.artifact(run.runId, traceId, "output");
      expect(JSON.parse(output.content)).toHaveProperty("value");
    }
    const identity = metrics.rows[0]?.protocolIdentity;
    if (identity === undefined) throw new Error("MISSING_PROTOCOL_IDENTITY");
    expect(await core.evaluation.compare({ a: { protocolIdentity: identity, runIds: [run.runId] }, b: { protocolIdentity: identity, runIds: [run.runId] } })).toMatchObject({ comparable: true });
    await expect(core.evaluation.compare({ a: { protocolIdentity: identity }, b: { protocolIdentity: "different" } })).rejects.toThrow("CROSS_PROTOCOL_COMPARISON_REFUSED");
    expect(await core.evaluation.compare({ a: { protocolIdentity: "missing", runIds: [run.runId] }, b: { protocolIdentity: "missing", runIds: [run.runId] } })).toMatchObject({ comparable: false, error: "NO_MATCHING_PROVIDER_ACTIVITY" });
  });

  it.each(["resolved", "still_blocking"] as const)("revises blocking critique once and independently checks the result: %s", async (revision) => {
    const { create, config, requests, failCritic } = await fixture({ revision });
    failCritic(true);
    const core = create(); const result = await core.run(config);
    expect(result.state).toBe("FAILED");
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(1);
    failCritic(false);
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(3);
    const gate = await resumed.gate(result.runId);
    expect(gate.reasons.includes("blocking_critic_feedback")).toBe(revision === "still_blocking");
    const descriptor = (await resumed.artifacts(result.runId)).find(({ kind }) => kind === "plan-ir");
    if (descriptor === undefined) throw new Error("PLAN_ABSENT");
    expect(JSON.parse((await resumed.artifact(result.runId, descriptor.artifactId) as { content: string }).content).title).toBe("Revised plan");
  });

  it.each(["invalid_traceability", "missing_resolution"] as const)("rejects invalid planner revisions: %s", async (revision) => {
    const { create, config, requests } = await fixture({ revision });
    const result = await create().run(config);
    expect(result.state).toBe("FAILED");
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(1);
  });

  it("partitions large critic plans while preserving complete record coverage", async () => {
    const { create, config, requests, failCritic } = await fixture({ largeCriticContext: true });
    failCritic(true);
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("FAILED");
    expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(2);
    failCritic(false);
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    const artifacts = await resumed.artifacts(result.runId);
    const descriptor = artifacts.find(({ kind }) => kind === "critic-context-batches");
    if (descriptor === undefined) throw new Error("CRITIC_BATCHES_ABSENT");
    const batches = JSON.parse((await core.artifact(result.runId, descriptor.artifactId) as { content: string }).content) as { kind: string; recordIds: string[] }[];
    expect(batches.length).toBeGreaterThan(1);
    expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(batches.length + 1);
    const primary = batches.filter(({ kind }) => kind === "review").flatMap(({ recordIds }) => recordIds);
    expect(primary.filter((id) => id.startsWith("task:"))).toHaveLength(4);
    expect(primary.filter((id) => id.startsWith("issue:"))).toHaveLength(1);
    expect(primary.filter((id) => id.startsWith("validation:"))).toHaveLength(1);
    const feedbackDescriptor = artifacts.find(({ kind }) => kind === "critic-feedback");
    if (feedbackDescriptor === undefined) throw new Error("CRITIC_FEEDBACK_ABSENT");
    const feedback = JSON.parse((await resumed.artifact(result.runId, feedbackDescriptor.artifactId) as { content: string }).content) as { items: { id: string }[] };
    expect(feedback.items).toHaveLength(batches.length);
    expect(new Set(feedback.items.map(({ id }) => id)).size).toBe(batches.length);
    const resultDescriptor = artifacts.find(({ kind }) => kind === "critic-result");
    if (resultDescriptor === undefined) throw new Error("CRITIC_RESULT_ABSENT");
    expect(JSON.parse((await resumed.artifact(result.runId, resultDescriptor.artifactId) as { content: string }).content)).toMatchObject({ criticCalls: batches.length, degradedReviewCoverage: false });
  });

  it("batches oversized peer context without losing candidate or cross-batch pair coverage", async () => {
    const { create, config, requests, failVerification } = await fixture({ largePeerContext: true });
    failVerification(true);
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("FAILED");
    expect(requests.some(({ stage }) => stage === "merge-check")).toBe(true);
    const completedReviews = requests.filter(({ stage }) => stage === "review" || stage === "merge-check").length;
    failVerification(false);
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "review" || stage === "merge-check")).toHaveLength(completedReviews);
    const descriptors = (await core.artifacts(result.runId)).filter(({ kind }) => kind.startsWith("peer-review-batches-1-"));
    expect(descriptors).toHaveLength(3);
    for (const descriptor of descriptors) {
      const parts = JSON.parse((await core.artifact(result.runId, descriptor.artifactId) as { content: string }).content) as { kind: string; candidateIds: string[] }[];
      const reviewed = parts.filter(({ kind }) => kind === "review").flatMap(({ candidateIds }) => candidateIds);
      expect(reviewed).toHaveLength(4); expect(new Set(reviewed).size).toBe(4);
      for (const left of reviewed) for (const right of reviewed) if (left !== right) expect(parts.some(({ candidateIds }) => candidateIds.includes(left) && candidateIds.includes(right))).toBe(true);
    }
  });

  it.each(["retain_original", "proposal-1"] as const)("resolves deferred peer operations with evidence-backed agreement: %s", async (conflictResolution) => {
    const { create, config, requests } = await fixture({ conflictingReview: true, conflictResolution });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "conflict")).toHaveLength(3);
    const artifacts = await core.artifacts(result.runId);
    const read = async (kind: string): Promise<unknown> => {
      const descriptor = artifacts.find((artifact) => artifact.kind === kind);
      if (descriptor === undefined) throw new Error(`MISSING_ARTIFACT:${kind}`);
      return JSON.parse((await core.artifact(result.runId, descriptor.artifactId) as { content: string }).content);
    };
    expect(await read("peer-operation-conflicts")).toEqual([]);
    expect(await read("peer-operation-resolutions")).toMatchObject([{ round: 2, votes: [{ evidenceIds: expect.any(Array) }, { evidenceIds: expect.any(Array) }, { evidenceIds: expect.any(Array) }] }]);
    const state = await read("consensus-state") as { board: { candidates: Record<string, unknown> } };
    expect(Object.keys(state.board.candidates)).toHaveLength(conflictResolution === "retain_original" ? 1 : 2);
  });

  it.each([0, 1, 3])("bounds durable semantic clustering to %i pairs", async (maximumClusteringPairs) => {
    const fixture_ = await fixture({ ambiguousClustering: true });
    const config = runConfigSchema.parse({ ...fixture_.config, workflow: { ...fixture_.config.workflow, modelExecution: { ...(fixture_.config.workflow["modelExecution"] as object), maximumClusteringPairs } } });
    const core = fixture_.create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(fixture_.requests.filter(({ stage }) => stage === "clustering")).toHaveLength(maximumClusteringPairs);
    const descriptor = (await core.artifacts(result.runId)).find(({ kind }) => kind === "clustering");
    if (descriptor === undefined) throw new Error("CLUSTERING_ARTIFACT_ABSENT");
    const artifact = await core.artifact(result.runId, descriptor.artifactId) as { content: string };
    const clustering = JSON.parse(artifact.content) as { clusters: unknown[]; ambiguousPairs: { relationship: string | null }[]; metrics: { semanticClusteringTokens: number | null } };
    expect(clustering.clusters).toHaveLength(maximumClusteringPairs === 0 ? 3 : maximumClusteringPairs === 1 ? 2 : 1);
    expect(clustering.ambiguousPairs.filter(({ relationship }) => relationship === null)).toHaveLength(3 - maximumClusteringPairs);
    expect(clustering.metrics.semanticClusteringTokens).toBe(maximumClusteringPairs === 0 ? 0 : null);
  });

  it("reuses conflict resolutions after a later failure and restart", async () => {
    const fixture_ = await fixture({ conflictingReview: true, conflictResolution: "retain_original" });
    fixture_.failVerification(true);
    const result = await fixture_.create().run(fixture_.config);
    expect(result.state).toBe("FAILED");
    expect(fixture_.requests.filter(({ stage }) => stage === "conflict")).toHaveLength(3);
    fixture_.failVerification(false);
    const resumed = fixture_.create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    expect(fixture_.requests.filter(({ stage }) => stage === "conflict")).toHaveLength(3);
  });

  it("bounds source context in every later model stage and records omitted source", async () => {
    const { create, config } = await fixture({ oversizedRepository: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const descriptors = (await core.artifacts(result.runId)).filter(({ kind }) => kind.startsWith("model-context-"));
    const contexts = await Promise.all(descriptors.map(async ({ artifactId }) => {
      const artifact = await core.artifact(result.runId, artifactId) as { content: string };
      return JSON.parse(artifact.content) as { activityId: string; omittedPaths: string[]; estimatedTokens: number; maximumEstimatedTokens: number };
    }));
    expect(new Set(contexts.map(({ activityId }) => activityId.split("/")[0]))).toEqual(new Set(["peer-review", "verification", "planner", "critic"]));
    expect(contexts.every(({ omittedPaths, estimatedTokens, maximumEstimatedTokens }) => omittedPaths.includes("large.ts") && estimatedTokens <= maximumEstimatedTokens)).toBe(true);
  });

  it("reuses semantic decisions after a downstream failure and restart", async () => {
    const fixture_ = await fixture({ ambiguousClustering: true });
    fixture_.failVerification(true);
    const core = fixture_.create(); const result = await core.run(fixture_.config);
    expect(result.state).toBe("FAILED");
    expect(fixture_.requests.filter(({ stage }) => stage === "clustering")).toHaveLength(3);
    fixture_.failVerification(false);
    const resumed = fixture_.create();
    await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    expect(fixture_.requests.filter(({ stage }) => stage === "clustering")).toHaveLength(3);
  });

  it("preserves conflicting structural proposals and completes with explicit unresolved coverage", async () => {
    const { create, config } = await fixture({ conflictingReview: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const conflict = artifacts.find(({ kind }) => kind === "peer-operation-conflicts");
    const canonical = artifacts.find(({ kind }) => kind === "canonical-issues");
    if (conflict === undefined || canonical === undefined) throw new Error("CONFLICT_ARTIFACT_ABSENT");
    const recorded = await core.artifact(result.runId, conflict.artifactId) as { content: string };
    expect(JSON.parse(recorded.content)).toMatchObject([{ reason: "overlapping_structural_edits", proposals: [{ type: "split" }, { type: "split" }] }]);
    const issueArtifact = await core.artifact(result.runId, canonical.artifactId) as { content: string };
    const value = JSON.parse(issueArtifact.content) as { issues: unknown[]; limitations: string[]; coverage: { complete: boolean } };
    expect(value.issues).toHaveLength(1);
    expect(value.limitations).toContain("unresolved_peer_operation_conflicts:1");
    expect(value.coverage.complete).toBe(false);
    expect((await core.gate(result.runId)).gateStatus).toBe("failed");
  });

  it("carries typed structural edits and counter-evidence through verification and planning", async () => {
    const { create, config } = await fixture({ structuralReview: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const canonical = (await core.artifacts(result.runId)).find(({ kind }) => kind === "canonical-issues");
    if (canonical === undefined) throw new Error("CANONICAL_ARTIFACT_ABSENT");
    const artifact = await core.artifact(result.runId, canonical.artifactId) as { content: string };
    const value = JSON.parse(artifact.content) as { issues: { counterEvidence: unknown[]; verificationSupplements: string[] }[] };
    expect(value.issues).toHaveLength(2);
    expect(value.issues.every(({ counterEvidence, verificationSupplements }) => counterEvidence.length === 1 && verificationSupplements.includes("Exercise both branches."))).toBe(true);
  });

  it("dispatches low-risk reviews according to policy and records selection provenance", async () => {
    for (const [consensusPolicy, count] of [["full", 3], ["risk_weighted", 2], ["minimal", 0]] as const) {
      const { create, config, requests } = await fixture({ lowRisk: true });
      const core = create();
      const result = await core.run(runConfigSchema.parse({ ...config, consensusPolicy, maxConsensusRounds: 1 }));
      expect(result.state).toBe("COMPLETED");
      expect(requests.filter(({ stage }) => stage === "review")).toHaveLength(count);
      const round = (await core.artifacts(result.runId)).find(({ kind }) => kind === "peer-review-round-1");
      if (round === undefined) throw new Error("ROUND_ARTIFACT_ABSENT");
      const artifact = await core.artifact(result.runId, round.artifactId) as { content: string };
      const recorded = JSON.parse(artifact.content) as { dispatches: { candidateIds: string[] }[] };
      expect(recorded.dispatches.filter(({ candidateIds }) => candidateIds.length > 0)).toHaveLength(count);
    }
  });

  it("executes heterogeneous models through every audit stage with durable provenance", async () => {
    const { create, config, requests } = await fixture();
    const core = create();
    expect(await core.estimate(config)).toMatchObject({ estimate: { costUsd: null, providerCalls: null } });
    const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(new Set(requests.map(({ stage }) => stage))).toEqual(new Set(["discovery", "review", "verification", "planner", "critic"]));
    expect(result.summary).toMatchObject({ auditorCount: 3, acceptedCount: 1, limitations: expect.arrayContaining(["auditor_kind:model_auditors"]) });
    expect((await core.artifacts(result.runId)).some(({ kind }) => kind === "model-token-budget")).toBe(true);
    const artifacts = await core.artifacts(result.runId);
    const trace = artifacts.find(({ kind }) => kind.startsWith("model-activity-") && kind.endsWith("-trace"));
    if (trace === undefined) throw new Error("MODEL_TRACE_ABSENT");
    const recorded = await core.artifact(result.runId, trace.artifactId) as { content: string };
    expect(JSON.parse(recorded.content)).toMatchObject({ terminal: {
      harnessId: "arbitra-canonical", harnessVersion: "1.0.0", outcome: "success", costUsd: null,
      modelProfileVersion: expect.stringMatching(/^[a-f0-9]{64}$/u), protocolHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u), inputArtifactRefs: expect.arrayContaining([expect.stringMatching(/^artifacts\//u)]),
    } });
    expect(artifacts.some(({ kind }) => kind.startsWith("compiled-prompt-"))).toBe(true);
    expect((await core.gate(result.runId)).reasons).toContain("degraded_coverage");
  });

  it("resumes a failed verification without repeating completed discovery or review", async () => {
    const fixture_ = await fixture();
    fixture_.failVerification(true);
    const core = fixture_.create();
    const result = await core.run(fixture_.config);
    expect(result.state).toBe("FAILED");
    const completedCalls = fixture_.requests.filter(({ stage }) => stage !== "verification").length;
    fixture_.failVerification(false);
    const resumed = fixture_.create();
    await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    expect(fixture_.requests.filter(({ stage }) => stage === "discovery")).toHaveLength(3);
    expect(fixture_.requests.filter(({ stage }) => stage !== "verification")).toHaveLength(completedCalls + 2);
  });

  it("honors a zero verification question budget and rejects invalid limits", async () => {
    const { create, config, requests } = await fixture();
    for (const maximum of [-1, 1.5, "4"]) expect(runConfigSchema.safeParse({ ...config, verification: { maxModelQuestionsPerRound: maximum } }).success).toBe(false);
    const bounded = runConfigSchema.parse({ ...config, verification: { maxModelQuestionsPerRound: 0 } });
    const core = create(); const result = await core.run(bounded);
    expect(result.state).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "verification")).toEqual([]);
    const artifacts = await core.artifacts(result.runId);
    const metrics = artifacts.find(({ kind }) => kind === "verification-metrics");
    if (metrics === undefined) throw new Error("VERIFICATION_METRICS_ABSENT");
    const recorded = await core.artifact(result.runId, metrics.artifactId) as { content: string };
    expect(JSON.parse(recorded.content)).toMatchObject({ itemCount: 1, modelCalls: 0, resolvedDisputes: 0 });
  });

  it("replays discovery into a distinct run and repeats downstream model stages", async () => {
    const { create, config, requests } = await fixture();
    const core = create(); const source = await core.run(config);
    const sourceEvents = []; for await (const event of core.events(source.runId)) sourceEvents.push(event);
    expect(source.state, JSON.stringify(sourceEvents.at(-1))).toBe("COMPLETED");
    const replay = await core.replay(source.runId, { consensusPolicy: "risk_weighted", maximumRounds: 1, criticEnabled: true });
    expect(replay.state).toBe("COMPLETED"); expect(replay.runId).not.toBe(source.runId);
    expect(requests.filter(({ stage }) => stage === "discovery")).toHaveLength(3);
    expect(requests.filter(({ stage }) => stage === "planner")).toHaveLength(2);
  });

  it("suspends budget exhaustion without dispatch and survives a restart", async () => {
    const { create, config, requests } = await fixture();
    const execution = config.workflow["modelExecution"] as Record<string, unknown>;
    const bounded = runConfigSchema.parse({ ...config, workflow: { ...config.workflow, modelExecution: { ...execution, maximumTokens: 2_000 } } });
    const core = create(); const result = await core.run(bounded);
    expect(result.state).toBe("SUSPENDED_BUDGET"); expect(requests).toHaveLength(0);
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("SUSPENDED_BUDGET"); expect(requests).toHaveLength(0);
  });

  it("cancels active model calls even if HTTP clients ignore cancellation", async () => {
    const fixture_ = await fixture();
    let sent: () => void = () => {};
    const dispatched = new Promise<void>((resolve) => { sent = resolve; });
    fixture_.blockDiscovery(sent);
    const core = fixture_.create(); const resource = await core.start(fixture_.config);
    await dispatched;
    expect((await core.cancel(resource.runId)).state).toBe("CANCELLED");
    expect((await core.gate(resource.runId)).gateStatus).toBe("failed");
  });
});
