import { cp, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import type { HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import { BUILTIN_TRANSPORT_FACTORIES, type TransportFactory, type TransportFactoryOptions } from "@arbitra/providers/registry.js";
import { Orchestrator } from "../src/orchestrator.js";
import { controlPlaneCore } from "../src/control-plane-core.js";
import { orchestratorCore } from "../src/cli-core.js";
import { taskOutline } from "../src/planner-context.js";
import type { PlannerBrief, PlannerTaskOutline } from "@arbitra/schemas/planner-composition.js";
import type { TestSandbox } from "../src/test-sandbox.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { secondFile?: boolean; revision?: "resolved" | "still_blocking" | "invalid_traceability" | "missing_resolution"; largePlannerContext?: boolean; largeCriticContext?: boolean; largePeerContext?: boolean; packedPeerContext?: boolean; mergeListedPair?: boolean; reviewOutputLimit?: boolean; lowRisk?: boolean; structuralReview?: boolean; conflictingReview?: boolean; invalidReview?: boolean; voteFlip?: "repairs" | "persists"; conflictResolution?: "retain_original" | "proposal-1"; conflictFault?: "invalid" | "output_limit"; ambiguousClustering?: boolean; oversizedRepository?: boolean; packedReviewSource?: boolean; planQuestion?: boolean; verifierContextTokens?: number; invalidVerification?: boolean; invalidGroupVerification?: boolean; unanimousReview?: boolean; verificationByPlace?: boolean; holdingPlaces?: readonly string[]; placeBesideMerge?: boolean; severities?: readonly string[]; critiqueVerdict?: "HOLDS" | "DOES_NOT_HOLD"; lowerSeverity?: "one" | "two"; severeRejection?: "REJECTED" | "CONFIRMED"; revisionQuestion?: boolean; depth?: "fast" | "balanced" | "deep"; finding?: { readonly severity?: string; readonly category?: string } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "arbitra-model-run-")); directories.push(directory);
  const manyIssues = options.largePeerContext === true || options.largePlannerContext === true;
  await writeFile(join(directory, "a.ts"), "const value = null;\n".repeat(manyIssues || options.placeBesideMerge === true ? 4 : options.ambiguousClustering === true ? 3 : 1), "utf8");
  if (options.secondFile === true) await writeFile(join(directory, "b.ts"), "export const other = 1;\n", "utf8");
  if (options.oversizedRepository === true) await writeFile(join(directory, "large.ts"), "// unrelated source\n".repeat(12_000), "utf8");
  // Many small files: a review carries as many as fit, so its prompt ends close to the size calls are packed to.
  if (options.packedReviewSource === true) for (let index = 0; index < 30; index += 1) await writeFile(join(directory, `part-${index}.ts`), `export const part${index} = "unrelated";\n`.repeat(100), "utf8");
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const template = example.models["auditor-a"];
  if (template === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const planTemplate = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  if (options.largeCriticContext === true) {
    const task = planTemplate.tasks[0]; const routing = planTemplate.routingRecommendations[0];
    if (task === undefined || routing === undefined) throw new Error("FIXTURE_PLAN_ABSENT");
    planTemplate.tasks = Array.from({ length: 4 }, (_, index) => ({ ...task, id: `TASK-${index}`, scope: { ...task.scope, likelyFiles: task.scope.likelyFiles.map((path) => `part-${index}/${path}`) }, implementationGuidance: ["Review this implementation detail. ".repeat(800)] }));
    planTemplate.routingRecommendations = planTemplate.tasks.map(({ id }) => ({ ...routing, taskId: id }));
  }
  const providers = ["openai", "anthropic", "google"];
  const transports = ["openai-responses", "anthropic-messages", "gemini-native"];
  const ids = ["auditor-a", "auditor-b", "auditor-c"];
  // The example reviews once. These audits allow a second round, which the tests of later rounds need. They run at
  // depth deep, where the plan critic always reads the plan.
  const config = runConfigSchema.parse({ ...example, auditDepth: options.depth ?? "deep", maxConsensusRounds: 2, models: Object.fromEntries(ids.map((id, index) => [id, { ...template, provider: providers[index], transport: transports[index], independenceGroup: id, modelId: id }])),
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
  if (options.verifierContextTokens !== undefined) {
    const verifier = config.models["auditor-b"]; if (verifier === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
    config.models["verifier-model"] = { ...verifier, modelId: "verifier-model", limits: { ...verifier.limits, contextTokens: options.verifierContextTokens } };
    const execution = config.workflow["modelExecution"] as { modelEndpoints: Record<string, string>; roles: { verifier: string } };
    execution.modelEndpoints["verifier-model"] = "auditor-b"; execution.roles.verifier = "verifier-model";
  }
  const requests: { stage: string; url: string; ceiling?: number }[] = [];
  const verificationInputs: { candidateId: string; unresolvedPeerOperations: { candidateIds: string[] }[]; sourcePaths: string[]; question?: string; findings?: Record<string, unknown>[]; request?: unknown }[] = [];
  // By place: a question about more than one place is rejected, and of the places only the holding ones (the second
  // line unless set) hold.
  const byPlace = (question: string) => { const places = question.match(/a\.ts:\d+/gu) ?? []; return places.length === 1 && (options.holdingPlaces ?? ["a.ts:2"]).includes(places[0] ?? "") ? "CONFIRMED" : "REJECTED"; };
  const plannerContexts: { unresolvedPeerOperations: { candidateIds: string[] }[] }[] = [];
  // What the staged planner's calls read: the files, and for an expansion the locations and the findings of its issues.
  const plannerReads: { stage: "outline" | "expand"; sourcePaths: string[]; locationIds: string[]; sourceFindingIds: string[] }[] = [];
  const plannerRead = (stage: "outline" | "expand", user: string): void => {
    const read = JSON.parse(user) as { repositoryContext: { ref: string }[]; projectContext: { sourceLocations: { id: string }[] }; canonicalIssues?: { sourceFindingIds: string[] }[] };
    plannerReads.push({ stage, sourcePaths: read.repositoryContext.map(({ ref }) => ref), locationIds: read.projectContext.sourceLocations.map(({ id }) => id), sourceFindingIds: (read.canonicalIssues ?? []).flatMap(({ sourceFindingIds }) => sourceFindingIds) });
  };
  const packedChecks: (readonly [string, string])[][] = [];
  const criticIssueIds: string[][] = [];
  const verificationFlight = { now: 0, most: 0 };
  let mergedListedPair: readonly [string, string] | undefined;
  const reviewInputs: { url: string; repair: boolean; input: { round: number; yourEarlierVotes?: { votes: Record<string, { vote: string; citedEvidenceIds: string[] }> } } }[] = [];
  let failVerification = false;
  let failCritic = false;
  let quotaUntil: string | null = null;
  let failExpansion = false;
  let failRevisionPatch = false;
  let blockDiscovery: (() => void) | undefined;
  const send = async (request: HttpRequest): Promise<HttpResponse> => {
    const body = request.body as { input?: { role: string; content: string }[]; system?: string; messages?: { content: string }[]; systemInstruction?: { parts: { text: string }[] }; contents?: { parts: { text: string }[] }[]; max_tokens?: number; max_output_tokens?: number; generationConfig?: { maxOutputTokens?: number } };
    const ceiling = body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens;
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
      requests.push({ stage: "discovery", url: request.url, ...(ceiling === undefined ? {} : { ceiling }) });
      if (blockDiscovery !== undefined) { blockDiscovery(); return new Promise(() => {}); }
      const auditorId = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(system)?.[1];
      const line = options.ambiguousClustering === true ? ids.indexOf(auditorId ?? "") + 1 : 1;
      output = { findings: [{ schemaVersion: 1, sourceFindingId: `${auditorId}/1`, category: options.finding?.category ?? "CORRECTNESS", title: "Null value", severity: options.lowRisk === true ? "low" : options.finding?.severity ?? "high", status: "needs_verification", confidence: 0.5, productionBlocker: false,
        locations: [{ id: `${auditorId}-L1`, path: "a.ts", startLine: line, endLine: line }], evidence: [{ id: `${auditorId}-E1`, text: "const value = null;", locationIds: [`${auditorId}-L1`] }],
        problem: "Fixture null claim", recommendedFix: "Check null", productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [] }], truncated: false, unexaminedDueToBudget: [], limitations: [] };
      // Beside the merge, a finding of another kind in the same file that clustering leaves on its own.
      if (options.placeBesideMerge === true && auditorId === "auditor-a") {
        const envelope = output as { findings: Record<string, unknown>[] };
        envelope.findings.push({ ...envelope.findings[0], sourceFindingId: "auditor-a/2", category: "RELIABILITY", title: "Unchecked value", problem: "Fixture unchecked claim", recommendedFix: "Guard reads",
          locations: [{ id: "auditor-a-L4", path: "a.ts", startLine: 4, endLine: 4 }], evidence: [{ id: "auditor-a-E4", text: "const value = null;", locationIds: ["auditor-a-L4"] }] });
      }
      if (manyIssues) {
        const envelope = output as { findings: Record<string, unknown>[] };
        const original = envelope.findings[0];
        envelope.findings = Array.from({ length: 4 }, (_, index) => ({ ...original, severity: options.severities?.[index] ?? original?.["severity"], sourceFindingId: `${auditorId}/${index + 1}`, title: `Null claim ${index}`, recommendedFix: `${index}: ` + "Check guard. ".repeat(options.packedPeerContext === true ? 600 : options.largePeerContext === true ? 750 : 1), locations: [{ id: `${auditorId}-L${index}`, path: "a.ts", startLine: index + 1, endLine: index + 1 }], evidence: [{ id: `${auditorId}-E${index}`, text: "const value = null;", locationIds: [`${auditorId}-L${index}`] }] }));
      }
    } else if (system.startsWith("Compare the supplied candidate pair")) {
      requests.push({ stage: "merge-check", url: request.url });
      expect(user).not.toMatch(/auditor-[abc]/u);
      output = { operations: [], findings: [], locations: [] };
      const input = JSON.parse(user) as { round: number; mergeCheckPairs?: (readonly [string, string])[]; candidates: Record<string, { sources?: { findingRef: string; evidence: { id: string }[] }[] }> };
      if (input.mergeCheckPairs !== undefined) packedChecks.push(input.mergeCheckPairs);
      const pair = input.mergeCheckPairs?.[0];
      // One reviewer finds that the first pair listed in its packed check shares a root cause.
      if (options.mergeListedPair === true && pair !== undefined && mergedListedPair === undefined && request.url.includes("auditor-a")) {
        mergedListedPair = pair;
        const sources = pair.flatMap((id) => input.candidates[id]?.sources ?? []);
        output = { operations: [{ operationId: "new:merge", candidateId: "new:merged", authorId: "self", round: input.round, type: "merge", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)), sourceCandidateIds: pair,
          candidate: { candidateId: "new:merged", title: "Merged null claim", description: "One shared null source", sourceFindingIds: sources.map(({ findingRef }) => findingRef), severity: "high", blocker: false } }], findings: [], locations: [] };
      }
    } else if (system.startsWith("Classify the relationship")) {
      requests.push({ stage: "clustering", url: request.url });
      expect(user).not.toMatch(/auditor-[abc]/u);
      // Several pairs arrive in one call; one pair keeps the single-decision reply.
      const pairs = (JSON.parse(user) as { pairs?: { pairId: string }[] }).pairs;
      output = pairs === undefined ? { relationship: "same_root_cause", rationale: "Fixture shared null source" } : { decisions: pairs.map(({ pairId }) => ({ pairId, relationship: "same_root_cause", rationale: "Fixture shared null source" })) };
    } else if (system.startsWith("Resolve the supplied")) {
      requests.push({ stage: "conflict", url: request.url });
      expect(user).not.toMatch(/auditor-[abc]/u);
      const input = JSON.parse(user) as { candidates: Record<string, { sources: { evidence: { id: string }[] }[] }> };
      output = { selection: options.conflictResolution ?? "unresolved", evidenceIds: Object.values(input.candidates).flatMap(({ sources }) => sources.flatMap(({ evidence }) => evidence.map(({ id }) => id))), rationale: "Fixture resolution based on supplied source" };
      // One auditor's answer names no supplied proposal, or stops at the output ceiling (the OpenAI Responses shape).
      if (options.conflictFault === "output_limit" && request.url.includes("auditor-a")) return { status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"selection":', usage: { input_tokens: 10, output_tokens: 2_000 } } };
      if (options.conflictFault === "invalid" && request.url.includes("auditor-a")) output = { ...(output as object), selection: "proposal-9" };
    } else if (system.startsWith("Review every")) {
      requests.push({ stage: "review", url: request.url });
      const input = JSON.parse(user) as { round: number; candidates: Record<string, { candidateId: string; sources: { findingRef: string; evidence: { id: string }[] }[] }> };
      // One reviewer's reply to more than one candidate stops at the output ceiling (the OpenAI Responses shape).
      if (options.reviewOutputLimit === true && request.url.includes("auditor-a") && Object.keys(input.candidates).length > 1) return { status: 200, headers: {}, body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"operations":', usage: { input_tokens: 10, output_tokens: 2_000 } } };
      expect(user).not.toMatch(/auditor-[abc]/u);
      output = { operations: Object.values(input.candidates).map(({ candidateId, sources }, index) => ({ operationId: `new:vote-${index}`, candidateId, authorId: "self", round: input.round, type: request.url.includes("auditor-b") && options.unanimousReview !== true ? "reject" : "accept", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)), reason: "Fixture review of supplied evidence" })), locations: [], findings: [] };
      if (options.largePlannerContext === true && input.round === 1 && request.url.includes("auditor-a")) {
        (output as { operations: unknown[] }).operations.push(...Object.values(input.candidates).map(({ candidateId, sources }, index) => ({ operationId: `new:supplement-${index}`, candidateId, authorId: "self", round: 1, type: "supplement_remediation", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)), text: `Original detail ${candidateId}: ` + "Preserve guard. ".repeat(1200) })));
      }
      // One reviewer, or two, lower every candidate to low.
      if (options.lowerSeverity !== undefined && input.round === 1 && (request.url.includes("auditor-a") || options.lowerSeverity === "two" && request.url.includes("auditor-b"))) {
        (output as { operations: unknown[] }).operations.push(...Object.values(input.candidates).map(({ candidateId, sources }, index) => ({ operationId: `new:lower-${index}`, candidateId, authorId: "self", round: 1, type: "change_severity", severity: "low", reason: "Fixture: only a developer path", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)) })));
      }
      const repair = JSON.stringify(request.body).includes("PEER_VOTE_CHANGED_WITHOUT_NEW_EVIDENCE");
      reviewInputs.push({ url: request.url, repair, input: JSON.parse(user) as (typeof reviewInputs)[number]["input"] });
      // A reviewer that changes its earlier reject to accept on the same evidence.
      if (options.voteFlip !== undefined && request.url.includes("auditor-b") && input.round > 1 && !(repair && options.voteFlip === "repairs")) {
        output = { ...(output as object), operations: (output as { operations: { type: string }[] }).operations.map((operation) => ({ ...operation, type: "accept" })) };
      }
      // A reviewer whose reply always claims another author's authority.
      if (options.invalidReview === true && request.url.includes("auditor-c")) output = { ...(output as object), operations: (output as { operations: { authorId: string }[] }).operations.map((operation) => ({ ...operation, authorId: "auditor-a",
        // A long rejected reply: its repair quotes it, so the repair does not fit beside the source the review carried.
        ...(options.packedReviewSource === true ? { reason: "Fixture review of the \"supplied\" evidence. ".repeat(400) } : {}) })) };
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
      requests.push({ stage: "verification", url: request.url, ...(ceiling === undefined ? {} : { ceiling }) });
      if (failVerification) return { status: 503, headers: {}, body: {} };
      const input = JSON.parse(user) as { request: { candidateId: string; question: string; context: { citedContext: { evidenceId: string }[] } }; findings: Record<string, unknown>[]; unresolvedPeerOperations: { candidateIds: string[] }[]; repository: { path: string }[] };
      verificationInputs.push({ candidateId: input.request.candidateId, unresolvedPeerOperations: input.unresolvedPeerOperations, sourcePaths: input.repository.map(({ path }) => path), question: input.request.question, findings: input.findings });
      // The answers take a moment, so questions asked side by side are in flight together.
      verificationFlight.now += 1; verificationFlight.most = Math.max(verificationFlight.most, verificationFlight.now);
      await new Promise((resolve) => setTimeout(resolve, 60));
      verificationFlight.now -= 1;
      // An answer that cites evidence the question did not supply is refused.
      // The verifier (auditor-b) rejects; a second opinion comes from the critic's model (auditor-c).
      const outcome = options.severeRejection !== undefined ? request.url.includes("auditor-c") ? options.severeRejection : "REJECTED"
        : options.verificationByPlace === true ? byPlace(input.request.question) : "CONFIRMED";
      output = { outcome, evidenceIds: options.invalidVerification === true ? ["evidence-never-supplied"] : input.request.context.citedContext.map(({ evidenceId }) => evidenceId), confidence: 0.8 };
    } else if (system.startsWith("Answer each of the verification questions")) {
      requests.push({ stage: "verification-group", url: request.url, ...(ceiling === undefined ? {} : { ceiling }) });
      const input = JSON.parse(user) as { questions: { request: { candidateId: string; question: string; context: { citedContext: { evidenceId: string }[] } }; findings: Record<string, unknown>[] }[]; repository: { path: string }[] };
      for (const { request: question, findings } of input.questions) verificationInputs.push({ candidateId: question.candidateId, unresolvedPeerOperations: [], sourcePaths: input.repository.map(({ path }) => path), question: question.question, findings, request: question });
      // A group answer that misses its questions is refused until its repairs run out.
      output = options.invalidGroupVerification === true ? { answers: [] } : { answers: input.questions.map(({ request: question }) => ({ candidateId: question.candidateId, outcome: options.verificationByPlace === true ? byPlace(question.question) : "CONFIRMED", evidenceIds: question.context.citedContext.map(({ evidenceId }) => evidenceId), confidence: 0.8 })) };
    } else if (system.startsWith("Read the complete accepted issues")) {
      requests.push({ stage: "planner-brief", url: request.url });
      const input = JSON.parse(user) as { canonicalIssues: { candidateId: string; remediationSupplements: string[] }[] };
      expect(input.canonicalIssues.every(({ remediationSupplements }) => remediationSupplements[0]?.includes("Original detail"))).toBe(true);
      output = { issues: input.canonicalIssues.map(({ candidateId }) => ({ issueId: candidateId, summary: "Null source claim with detailed guard constraints", affectedPaths: ["a.ts"], behavioralAssertions: ["Guard null values"], integrationConstraints: ["Preserve existing behavior"], unresolvedQuestions: [] })) };
    } else if (system.startsWith("Produce the single global plan outline")) {
      requests.push({ stage: "planner-outline", url: request.url });
      plannerRead("outline", user);
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
      plannerRead("expand", user);
      expect(input.canonicalIssues).toHaveLength(1);
      expect(input.canonicalIssues[0]?.remediationSupplements[0]).toContain("Original detail");
      output = { task: { ...planTemplate.tasks[0], ...input.selectedTask }, unresolvedQuestions: input.selectedTask.id === "TASK-4" ? [{ id: "Q-1", question: "Integration needs operator decision", blocking: true, blastRadius: "high" }] : [] };
    } else if (system.startsWith("Produce a complete")) {
      requests.push({ stage: "planner", url: request.url });
      const input = JSON.parse(user) as { canonicalIssues: { candidateId: string }[]; premiseReport: unknown };
      plannerContexts.push((JSON.parse(user) as { projectContext: (typeof plannerContexts)[number] }).projectContext);
      const acceptedIssueIds = input.canonicalIssues.map(({ candidateId }) => candidateId);
      output = { ...planTemplate, acceptedIssueIds, tasks: planTemplate.tasks.map((task) => ({ ...task, addresses: { ...task.addresses, issues: acceptedIssueIds } })),
        traceability: { ...planTemplate.traceability, issueToValidation: acceptedIssueIds.map((issueId) => ({ issueId, validationIds: ["VAL-001"] })) }, premiseReport: input.premiseReport,
        ...(options.planQuestion === true ? { unresolvedQuestions: [{ id: "Q-null", question: "Throw or default when the value is null?", blocking: true, blastRadius: "high" }] } : {}) };
    } else if (system.startsWith("Revise the supplied Plan IR to apply the operator's answers")) {
      requests.push({ stage: "plan-answers", url: request.url });
      const input = JSON.parse(user) as { plan: ReturnType<typeof planIRSchema.parse>; operatorAnswers: { questionId: string; answer: string }[] };
      expect(input.operatorAnswers).toEqual(options.revisionQuestion === true ? [{ questionId: "Q-revision", question: "Keep the old default for callers that pass no value?", answer: "Keep it." }]
        : [{ questionId: "Q-null", question: "Throw or default when the value is null?", answer: "Throw a typed error." }]);
      // The reply keeps the answered question; the runtime removes it.
      output = { ...input.plan, title: "Answered plan" };
    } else if (system.startsWith("Revise the selected tasks")) {
      requests.push({ stage: "revision-patch", url: request.url });
      if (failRevisionPatch && requests.filter(({ stage }) => stage === "revision-patch").length === 2) return { status: 503, headers: {}, body: {} };
      const input = JSON.parse(user) as { selectedTasks: ReturnType<typeof planIRSchema.parse>["tasks"]; selectedTaskIds: string[]; critique: { id: string }[] };
      expect(input.selectedTasks.length).toBeGreaterThan(0);
      expect(input.selectedTasks.every(({ implementationGuidance }) => implementationGuidance[0]?.startsWith("Review this implementation detail."))).toBe(true);
      // A part of the plan cannot retitle it; what it adds to the plan marks it revised for the critic.
      output = { resolutions: input.critique.map(({ id }) => ({ critiqueItemId: id, resolution: "Added the required acceptance assertion and retained original implementation detail" })),
        tasks: input.selectedTasks.map((task) => ({ ...task, acceptanceCriteria: [...task.acceptanceCriteria, ...input.critique.map(({ id }) => `Resolved ${id}`)] })), retiredTaskIds: [],
        lineage: input.selectedTaskIds.map((id) => ({ previousTaskId: id, nextTaskIds: [id], rationale: "Same behavioral task with improved acceptance" })),
        addedQuestions: [], addedValidation: [], issueToValidation: [], requirementLinks: [], planAdditions: { implementationStrategy: [], dependencies: [], rolloutConcerns: ["Revised plan"], migrationConcerns: [] } };
    } else if (system.startsWith("Revise the supplied")) {
      requests.push({ stage: "revision", url: request.url });
      const input = JSON.parse(user) as { originalPlan: ReturnType<typeof planIRSchema.parse>; blockingCritique: { id: string }[] };
      // A revision may ask a blocking question of its own; its rollout note keeps the answered plan marked revised.
      const asked = options.revisionQuestion === true ? { unresolvedQuestions: [...input.originalPlan.unresolvedQuestions, { id: "Q-revision", question: "Keep the old default for callers that pass no value?", blocking: true, blastRadius: "high" }],
        rolloutConcerns: [...input.originalPlan.rolloutConcerns, "Revised plan"] } : {};
      output = { plan: { ...input.originalPlan, title: "Revised plan", ...asked, ...(options.revision === "invalid_traceability" ? { acceptedIssueIds: [] } : {}) }, resolutions: options.revision === "missing_resolution" ? [] : input.blockingCritique.map(({ id }) => ({ critiqueItemId: id, resolution: "Added the requested validation" })) };
    } else if (system.startsWith("Decide whether the supplied blocking critique")) {
      requests.push({ stage: "critique-check", url: request.url });
      const input = JSON.parse(user) as { critique: { summary: string }; tasks: { id: string }[] };
      expect(input.tasks.length).toBeGreaterThan(0);
      output = { verdict: options.critiqueVerdict ?? "HOLDS", reason: "Fixture check of the named task against the source" };
    } else if (system.startsWith("Critique the plan")) {
      requests.push({ stage: "critic", url: request.url });
      if (failCritic && requests.filter(({ stage }) => stage === "critic").length === 2) return { status: 503, headers: {}, body: {} };
      if (quotaUntil !== null && requests.filter(({ stage }) => stage === "critic").length === 1) return { status: 429, headers: {}, body: { error: { code: "insufficient_quota", message: `You exceeded your current quota until ${quotaUntil}` } } };
      const input = JSON.parse(user) as { plan: { title: string; rolloutConcerns?: string[]; tasks: { id: string }[] }; canonicalIssues: { candidateId: string }[]; reviewScope?: { globalIndex: { tasks: { id: string }[] } } };
      criticIssueIds.push(input.canonicalIssues.map(({ candidateId }) => candidateId));
      const taskId = input.plan.tasks[0]?.id ?? input.reviewScope?.globalIndex.tasks[0]?.id;
      const blocking = options.revision !== undefined && (input.plan.title !== "Revised plan" && !(input.plan.rolloutConcerns ?? []).includes("Revised plan") || options.revision === "still_blocking");
      output = { summary: "Fixture critique", items: options.largeCriticContext === true || blocking ? [{ id: "local-1", category: "weak_verification", blocking, summary: "Fixture mapped feedback", taskIds: [taskId], issueIds: [] }] : [] };
    } else throw new Error("UNKNOWN_FIXTURE_STAGE");
    const text = JSON.stringify(output);
    const response = request.url.includes("auditor-b") ? { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } }
      : request.url.includes("auditor-c") ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }
      : { output_text: text, usage: { input_tokens: 10, output_tokens: 20 } };
    return { status: 200, headers: {}, body: response };
  };
  const create = (testSandbox?: TestSandbox, providerOptions: TransportFactoryOptions & { readonly factories?: Readonly<Record<string, TransportFactory>> } = {}) => new Orchestrator({ repository: directory, stateDirectory: join(directory, ".runs"), providerOptions: { client: { send }, credential: () => "fixture-credential", ...providerOptions }, ...(testSandbox === undefined ? {} : { testSandbox }) });
  return { directory, create, config, requests, verificationInputs, plannerContexts, plannerReads, reviewInputs, packedChecks, criticIssueIds, verificationFlight, mergedListedPair: () => mergedListedPair, failRevisionPatch: (value: boolean) => { failRevisionPatch = value; }, failExpansion: (value: boolean) => { failExpansion = value; }, failCritic: (value: boolean) => { failCritic = value; }, quotaCritic: (until: string) => { quotaUntil = until; }, failVerification: (value: boolean) => { failVerification = value; }, blockDiscovery: (callback: () => void) => { blockDiscovery = callback; } };
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
  it("closes a run's transports once the run settles, when it fails and when its resume completes", async () => {
    // A CLI transport keeps a session for its next tool turn and sweeps it only inside a later call, which a
    // settled run never makes.
    const setup = await fixture(); const closed: string[] = [];
    const factories = Object.fromEntries(Object.entries(BUILTIN_TRANSPORT_FACTORIES).map(([id, factory]): [string, TransportFactory] => [id,
      (configuration, options) => Object.assign(factory(configuration, options), { async close() { closed.push(configuration.endpoint); } })]));
    const endpoints = ["https://auditor-a.example/v1", "https://auditor-b.example/v1", "https://auditor-c.example/v1"];
    const failing = setup.create(undefined, { factories, client: { async send() { return { status: 503, headers: {}, body: {} }; } } });
    const failed = await failing.run(setup.config);
    expect(failed.state).toBe("FAILED");
    await vi.waitFor(() => { expect([...closed].sort()).toEqual(endpoints); });
    closed.length = 0;
    const resumed = setup.create(undefined, { factories }); await resumed.resume(failed.runId);
    expect((await resumed.wait(failed.runId)).state).toBe("COMPLETED");
    await vi.waitFor(() => { expect([...closed].sort()).toEqual(endpoints); });
  });
  it.each(["resolved", "still_blocking"] as const)("resumes oversized planner revisions and rechecks every critique claim: %s", async (revision) => {
    const { create, config, requests, failRevisionPatch } = await fixture({ largeCriticContext: true, revision });
    (config.workflow["modelExecution"] as { review?: object }).review = { recheckRevisedPlan: true, criticPairChecks: true };
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
    // Items on the same tasks share a call; the call that failed before the resume is one more.
    const patches = await read("planner-revision-patches") as { critiqueItemIds: string[] }[];
    expect(patches.flatMap(({ critiqueItemIds }) => critiqueItemIds).sort()).toEqual(original.items.map(({ id }) => id).sort());
    expect(requests.filter(({ stage }) => stage === "revision-patch")).toHaveLength(patches.length + 1);
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(0);
    expect(revised.plan.tasks).toHaveLength(4);
    expect(revised.plan.tasks.every(({ implementationGuidance }) => implementationGuidance[0]?.startsWith("Review this implementation detail."))).toBe(true);
    const batches = await read("critic-revision-context-batches") as { kind: string; recordIds: string[] }[];
    const primary = batches.filter(({ kind }) => kind === "review").flatMap(({ recordIds }) => recordIds);
    expect(primary.filter((id) => id.startsWith("revision:")).sort()).toEqual(original.items.map(({ id }) => `revision:${id}`).sort());
    for (const { id } of original.items) for (const task of revised.plan.tasks) expect(batches.some(({ recordIds }) => recordIds.includes(`revision:${id}`) && recordIds.includes(`task:${task.id}`))).toBe(true);
    expect((await resumed.gate(run.runId)).reasons.includes("blocking_critic_feedback")).toBe(revision === "still_blocking");
  }); // package limit (90 s): ~32 s per case alone, over 60 s under full-suite load

  it("gives a task expansion the files and the locations of its own task and issues", async () => {
    // Observed live (P20 pilot): each of 31 expansions read the whole outline, the locations of all 52 issues and every file that fitted.
    const { create, config, plannerReads } = await fixture({ largePlannerContext: true, secondFile: true });
    const run = await create().run(config);
    expect(run.state).toBe("COMPLETED");
    const outline = plannerReads.filter(({ stage }) => stage === "outline"); const expansions = plannerReads.filter(({ stage }) => stage === "expand");
    expect(outline).toHaveLength(1); expect(expansions).toHaveLength(4);
    // The outline reads every file as far as it fits, b.ts among them, and where every issue points.
    expect(outline[0]?.sourcePaths).toContain("b.ts");
    for (const read of expansions) {
      // No issue cites b.ts. An expansion reads the file its issue cites and the locations of that issue's findings.
      expect(read.sourcePaths).toEqual(["a.ts"]);
      expect(read.locationIds.length).toBeGreaterThan(0); expect(read.locationIds.length).toBeLessThan(outline[0]?.locationIds.length ?? 0);
      expect(read.locationIds.every((id) => read.sourceFindingIds.some((sourceId) => id.startsWith(`${sourceId}/`)))).toBe(true);
    }
  });

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
  });

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
    (config.workflow["modelExecution"] as { review?: object }).review = { recheckRevisedPlan: true };
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

  it("pauses on a used-up usage allowance instead of failing, and goes on by itself after the reset", async () => {
    // Observed live: the Codex five-hour window ran out at the critic and failed a run whose audit and plan were done.
    const { create, config, requests, quotaCritic } = await fixture();
    // The reset is already past, so the wake-up resumes the run at once.
    quotaCritic(new Date(Date.now() - 120_000).toISOString());
    const core = create(); const result = await core.run(config);
    expect(result.state).toBe("SUSPENDED_RATE_LIMIT");
    expect((await core.overview(result.runId)).reason).toMatch(/^ProviderUsageLimitError: .*insufficient_quota/u);
    await vi.waitFor(async () => { expect((await core.status(result.runId)).state).toBe("COMPLETED"); }, { timeout: 15_000, interval: 100 });
    expect(requests.filter(({ stage }) => stage === "critic").length).toBeGreaterThan(1);
  });

  it("waits for answers to blocking plan questions, then applies them with one planner call", async () => {
    // Observed live: an Audit plan correctly left "throw or clamp?" open and failed its gate, with no way to answer it.
    const { directory, create, config, requests } = await fixture({ planQuestion: true });
    const interactive = { ...config, workflow: { ...config.workflow, checkpoints: { mode: "interactive" } } };
    const core = create(); const result = await core.run(interactive);
    expect(result.state).toBe("BLOCKED");
    const status = await core.status(result.runId);
    const pending = status.checkpoints.find((checkpoint) => checkpoint.kind === "plan-questions");
    if (pending?.kind !== "plan-questions") throw new Error("PLAN_QUESTIONS_CHECKPOINT_ABSENT");
    expect(pending).toMatchObject({ checkpointId: "plan-questions", status: "pending", questions: [{ id: "Q-null", blastRadius: "high" }] });
    expect((await core.gate(result.runId)).reasons).toEqual(expect.arrayContaining(["checkpoint_pending:plan-questions", "blocking_plan_questions"]));
    // The run list counts the unanswered questions as the run's one pending decision.
    const listed = async () => (await core.listRuns()).find(({ runId }) => runId === result.runId);
    expect(await listed()).toMatchObject({ state: "BLOCKED", pendingDecisions: 1, gate: null });
    // Observed live: a stage's work lands as artifacts between state changes, and "last activity" stayed at the run's start.
    const later = new Date(Date.parse((await listed())?.updatedAt ?? "") + 60_000);
    await utimes(join(directory, ".runs", "runs", result.runId, "artifacts.json"), later, later);
    expect((await listed())?.updatedAt).toBe(later.toISOString());
    await expect(core.respondCheckpoint(result.runId, "plan-questions", { version: pending.version, answers: [{ questionId: "Q-other", answer: "Clamp." }] })).rejects.toThrow("PLAN_QUESTION_ANSWERS_INVALID");
    await expect(core.respondCheckpoint(result.runId, "plan-questions", { version: "0".repeat(64), answers: [{ questionId: "Q-null", answer: "Clamp." }] })).rejects.toThrow("STALE_CHECKPOINT");
    // The CLI reads the answers from a file: respond-checkpoint <run> plan-questions <version> answers.json
    const answersDirectory = await mkdtemp(join(tmpdir(), "arbitra-plan-answers-")); directories.push(answersDirectory);
    await writeFile(join(answersDirectory, "answers.json"), JSON.stringify({ answers: [{ questionId: "Q-null", answer: "Throw a typed error." }] }), "utf8");
    const answered = await orchestratorCore(core).respondCheckpoint(result.runId, "plan-questions", pending.version, join(answersDirectory, "answers.json"));
    expect(answered.value).toMatchObject({ accepted: true, checkpoint: { status: "answered" } });
    // The answers are a create-once record that touches none of the files the list cache watches.
    expect(await listed()).toMatchObject({ state: "BLOCKED", pendingDecisions: 0 });
    await expect(core.respondCheckpoint(result.runId, "plan-questions", { version: pending.version, answers: [{ questionId: "Q-null", answer: "Clamp." }] })).rejects.toThrow("CHECKPOINT_ALREADY_DECIDED");
    const planned = requests.filter(({ stage }) => stage === "planner").length;
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    // The stored planner activities replayed; exactly one new call applied the answers.
    expect(requests.filter(({ stage }) => stage === "planner")).toHaveLength(planned);
    expect(requests.filter(({ stage }) => stage === "plan-answers")).toHaveLength(1);
    const read = async (kind: string) => {
      const descriptor = (await resumed.artifacts(result.runId)).find((entry) => entry.kind === kind);
      if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`);
      return JSON.parse((await resumed.artifact(result.runId, descriptor.artifactId) as { content: string }).content) as Record<string, unknown>;
    };
    expect(await read("plan-ir")).toMatchObject({ title: "Answered plan", unresolvedQuestions: [] });
    expect(await read("plan-question-resolutions")).toMatchObject({ rounds: [{ version: pending.version, activityId: `planner/answers/${pending.version}`, answeredBy: "operator", answers: [{ questionId: "Q-null", answer: "Throw a typed error." }] }] });
    const gate = await resumed.gate(result.runId);
    expect(gate.reasons).not.toContain("blocking_plan_questions");
    expect(gate.reasons).not.toContain("checkpoint_pending:plan-questions");
  });

  it.each([false, true])("waits for answers to the blocking questions a critic's revision asks, before any recheck reads the plan (recheck: %s)", async (recheck) => {
    // A revision asks blocking questions of its own: about an item it could not revise, or a decision a fix needs.
    const { create, config, requests } = await fixture({ revision: "resolved", revisionQuestion: true });
    if (recheck) (config.workflow["modelExecution"] as { review?: object }).review = { recheckRevisedPlan: true };
    const interactive = { ...config, workflow: { ...config.workflow, checkpoints: { mode: "interactive" } } };
    const core = create(); const result = await core.run(interactive);
    expect(result.state).toBe("BLOCKED");
    const pending = (await core.status(result.runId)).checkpoints.find((checkpoint) => checkpoint.kind === "plan-questions");
    if (pending?.kind !== "plan-questions") throw new Error("PLAN_QUESTIONS_CHECKPOINT_ABSENT");
    expect(pending).toMatchObject({ status: "pending", questions: [{ id: "Q-revision", blastRadius: "high" }] });
    await core.respondCheckpoint(result.runId, "plan-questions", { version: pending.version, answers: [{ questionId: "Q-revision", answer: "Keep it." }] });
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    // The critic, its check and the revision replayed; one new call applied the answer, and a recheck read the answered plan.
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "plan-answers")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(recheck ? 2 : 1);
    const read = async (kind: string) => {
      const descriptor = (await resumed.artifacts(result.runId)).find((entry) => entry.kind === kind);
      if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`);
      return JSON.parse((await resumed.artifact(result.runId, descriptor.artifactId) as { content: string }).content) as Record<string, unknown>;
    };
    const plan = await read("plan-ir") as { title: string; unresolvedQuestions: { id: string; blocking: boolean }[] };
    expect(plan.title).toBe("Answered plan");
    expect(plan.unresolvedQuestions.filter(({ id, blocking }) => blocking || id === "Q-revision")).toEqual([]);
    expect(await read("plan-revision-question-resolutions")).toMatchObject({ rounds: [{ version: pending.version, answeredBy: "operator", answers: [{ questionId: "Q-revision", answer: "Keep it." }] }] });
    const gate = await resumed.gate(result.runId);
    expect(gate.reasons).not.toContain("blocking_plan_questions");
    expect(gate.reasons).not.toContain("blocking_critic_feedback");
  });

  it("runs the plan critic at depth deep or for a critical or high security issue, and otherwise records it as not required", async () => {
    // A critic node makes a critic available; the run's depth and the planned issues decide whether it reads the plan
    // (spec §20.6), and critic-result records why.
    const cases = [
      { depth: "balanced", finding: {}, status: "not_required", reasons: [] },
      { depth: "deep", finding: {}, status: "completed", reasons: ["deep_mode"] },
      { depth: "balanced", finding: { severity: "critical" }, status: "completed", reasons: ["critical_issue"] },
      { depth: "balanced", finding: { category: "SECURITY" }, status: "completed", reasons: ["high_security_issue"] },
    ] as const;
    for (const { depth, finding, status, reasons } of cases) {
      const { create, config, requests } = await fixture({ depth, finding });
      const core = create(); const result = await core.run(config);
      expect(result.state).toBe("COMPLETED");
      const descriptor = (await core.artifacts(result.runId)).find(({ kind }) => kind === "critic-result");
      const recorded = JSON.parse((await core.artifact(result.runId, descriptor?.artifactId ?? "") as { content: string }).content) as { status: string; requirement: { reasons: string[] }; degradedReviewCoverage: boolean };
      expect({ depth, finding, status: recorded.status, reasons: recorded.requirement.reasons, degraded: recorded.degradedReviewCoverage }).toEqual({ depth, finding, status, reasons, degraded: false });
      expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(status === "completed" ? 1 : 0);
      expect((await core.gate(result.runId)).reasons).not.toContain("degraded_critic_coverage");
    }
  });

  it("holds the gate when no critic qualifies, rather than reporting the plan as reviewed", async () => {
    // A critic below the planner's capability is skipped (spec §20.6); the empty feedback it leaves is not a pass.
    const { create, config, requests } = await fixture({ revision: "still_blocking" });
    const critic = config.models["auditor-c"]; if (critic === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
    config.models["auditor-c"] = { ...critic, capabilityTier: "fast" };
    const core = create(); const result = await core.run(config);
    expect(result.state).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "critic" || stage === "revision")).toEqual([]);
    const read = async <T>(kind: string) => { const descriptor = (await core.artifacts(result.runId)).find((artifact) => artifact.kind === kind); return JSON.parse((await core.artifact(result.runId, descriptor?.artifactId ?? "") as { content: string }).content) as T; };
    expect(await read("critic-result")).toMatchObject({ status: "skipped", degradedReviewCoverage: true, selection: { reason: "no_available_critic_at_or_above_planner_capability" } });
    expect(await read("critic-feedback")).toEqual({ summary: "critic skipped", items: [] });
    expect((await core.gate(result.runId)).reasons).toContain("degraded_critic_coverage");
  });

  it.each(["invalid_traceability", "missing_resolution"] as const)("rejects invalid planner revisions: %s", async (revision) => {
    const { create, config, requests } = await fixture({ revision });
    const result = await create().run(config);
    expect(result.state).toBe("FAILED");
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(1);
  });

  it.each([1, 4])("partitions large critic plans while preserving complete record coverage (%i calls at a time)", async (parallel) => {
    const { create, config, requests, failCritic } = await fixture({ largeCriticContext: true });
    if (parallel > 1) (config.workflow["modelExecution"] as { maximumParallelCalls?: number }).maximumParallelCalls = parallel;
    failCritic(true);
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("FAILED");
    // One part at a time stops at the failing second part; side by side, the parts in flight run to their end.
    if (parallel === 1) expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(2);
    else expect(requests.filter(({ stage }) => stage === "critic").length).toBeGreaterThanOrEqual(2);
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
    expect(JSON.parse((await resumed.artifact(result.runId, resultDescriptor.artifactId) as { content: string }).content)).toMatchObject({ criticCalls: batches.length, degradedReviewCoverage: false, citedSourceLeftOut: expect.any(Array) });
  });

  it("batches oversized peer context without losing candidate or cross-batch pair coverage", async () => {
    const { create, config, requests, failVerification } = await fixture({ largePeerContext: true });
    (config.workflow["modelExecution"] as { review?: object }).review = { crossBatchMergeChecks: true };
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

  it.each([1, 4])("halves a reviewer's batches when a review stops at the output ceiling, and plans the same batches after a restart (%i calls at a time)", async (parallel) => {
    // Observed live (P20 pilot): thinking counts as output, a review of 19 candidates passed the ceiling, and the run could not go on.
    const { create, config, requests, failVerification } = await fixture({ largePeerContext: true, packedPeerContext: true, reviewOutputLimit: true });
    if (parallel > 1) (config.workflow["modelExecution"] as { maximumParallelCalls?: number }).maximumParallelCalls = parallel;
    failVerification(true);
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    // The run stops at verification, after peer review has finished for every reviewer.
    expect(result.state, JSON.stringify(events.at(-1))).toBe("FAILED");
    expect(requests.some(({ stage }) => stage === "verification")).toBe(true);
    const artifacts = await core.artifacts(result.runId);
    const read = async (kind: string) => { const descriptor = artifacts.find((entry) => entry.kind === kind); if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${kind}`); return JSON.parse((await core.artifact(result.runId, descriptor.artifactId) as { content: string }).content) as unknown; };
    // The first batch held three candidates, so the reviewer goes on one candidate at a time; the other reviewers keep their batches.
    expect(await read("peer-review-batch-limits-1-auditor-a")).toMatchObject({ review: 1 });
    expect((await read("peer-review-batches-1-auditor-a") as { kind: string; candidateIds: string[] }[]).filter(({ kind }) => kind === "review").map(({ candidateIds }) => candidateIds.length)).toEqual([1, 1, 1, 1]);
    expect((await read("peer-review-batches-1-auditor-b") as { kind: string; candidateIds: string[] }[]).filter(({ kind }) => kind === "review").map(({ candidateIds }) => candidateIds.length)).toEqual([3, 1]);
    expect(artifacts.some(({ kind }) => kind === "peer-review-batch-limits-1-auditor-b")).toBe(false);
    const reviews = requests.filter(({ stage }) => stage === "review").length;
    failVerification(false);
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "review")).toHaveLength(reviews);
  });

  it.each([1, 4])("packs the pair checks between review batches into one call and applies the merge it returns (%i calls at a time)", async (parallel) => {
    // Observed live (P20 pilot): one call per pair asked one reviewer for 1,140 calls.
    const { create, config, requests, packedChecks, mergedListedPair, failVerification } = await fixture({ largePeerContext: true, packedPeerContext: true, mergeListedPair: true });
    (config.workflow["modelExecution"] as { review?: object }).review = { crossBatchMergeChecks: true };
    if (parallel > 1) (config.workflow["modelExecution"] as { maximumParallelCalls?: number }).maximumParallelCalls = parallel;
    failVerification(true);
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    // The run stops at verification, after consensus has published the board.
    expect(result.state, JSON.stringify(events.at(-1))).toBe("FAILED");
    // Reviewers run side by side, so the merged pair is the one the fixture's reviewer was shown, not the first check to arrive.
    const merged = mergedListedPair();
    if (merged === undefined) throw new Error("PACKED_CHECK_ABSENT");
    expect(packedChecks.some((pairs) => pairs.length === 2 && JSON.stringify(pairs[0]) === JSON.stringify(merged))).toBe(true);
    const artifacts = await core.artifacts(result.runId);
    const parts = async (auditorId: string) => { const descriptor = artifacts.find(({ kind }) => kind === `peer-review-batches-1-${auditorId}`); if (descriptor === undefined) throw new Error("BATCHES_ABSENT"); return JSON.parse((await core.artifact(result.runId, descriptor.artifactId) as { content: string }).content) as { kind: string; candidateIds: string[]; pairs?: [string, string][] }[]; };
    // Three candidates fit one call: two review batches, then one packed check of two pairs and one single pair, where one call per pair took three.
    expect((await parts("auditor-a")).map(({ kind, candidateIds, pairs }) => [kind, candidateIds.length, pairs?.length ?? null])).toEqual([["review", 3, null], ["review", 1, null], ["merge_check", 3, 2], ["merge_check", 2, null]]);
    expect(requests.filter(({ stage, url }) => stage === "merge-check" && url.includes("auditor-a")).length).toBeGreaterThanOrEqual(2);
    const operations = artifacts.find(({ kind }) => kind === "board-operations");
    if (operations === undefined) throw new Error("BOARD_OPERATIONS_ABSENT");
    const merges = (JSON.parse((await core.artifact(result.runId, operations.artifactId) as { content: string }).content) as { type: string; authorId: string; sourceCandidateIds?: string[] }[]).filter(({ type }) => type === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ authorId: "auditor-a", sourceCandidateIds: [...merged] });
  });

  it.each([["retain_original", 1], ["proposal-1", 1], ["proposal-1", 4]] as const)("resolves deferred peer operations with evidence-backed agreement: %s, %i calls at a time", async (conflictResolution, parallel) => {
    const { create, config, requests } = await fixture({ conflictingReview: true, conflictResolution });
    if (parallel > 1) (config.workflow["modelExecution"] as { maximumParallelCalls?: number }).maximumParallelCalls = parallel;
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

  it.each(["invalid", "output_limit"] as const)("leaves a conflict unresolved and goes on when one auditor's answer is %s", async (conflictFault) => {
    // One auditor's answer that stays invalid, or stops at the output ceiling, costs its vote, not the run.
    const { create, config, requests } = await fixture({ conflictingReview: true, conflictResolution: "proposal-1", conflictFault });
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
    const unanswered = artifacts.filter(({ kind }) => kind.startsWith("peer-conflict-unanswered-"));
    expect(unanswered).toHaveLength(1);
    expect(await read(unanswered[0]?.kind ?? "")).toMatchObject({ round: 2, auditorId: "auditor-a", activityId: expect.stringMatching(/^peer-conflict\/2\/.+\/auditor-a$/u) });
    // The two answers that came do not settle the conflict, so it stays open for verification and the plan.
    expect(await read("peer-operation-resolutions")).toEqual([]);
    expect(await read("peer-operation-conflicts")).toHaveLength(1);
  });

  it.each([0, 1, 3])("bounds durable semantic clustering to %i pairs", async (maximumClusteringPairs) => {
    const fixture_ = await fixture({ ambiguousClustering: true });
    const config = runConfigSchema.parse({ ...fixture_.config, workflow: { ...fixture_.config.workflow, modelExecution: { ...(fixture_.config.workflow["modelExecution"] as object), maximumClusteringPairs } } });
    const core = fixture_.create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    // Observed live (P20 pilot): one call per pair, each with the whole repository, was 57% of a single-auditor run's tokens. Several pairs now share one call.
    expect(fixture_.requests.filter(({ stage }) => stage === "clustering")).toHaveLength(Math.min(maximumClusteringPairs, 1));
    expect((await core.artifacts(result.runId)).filter(({ kind }) => kind.startsWith("clustering-decision-"))).toHaveLength(maximumClusteringPairs);
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
    expect(fixture_.requests.filter(({ stage }) => stage === "clustering")).toHaveLength(1);
    fixture_.failVerification(false);
    const resumed = fixture_.create();
    await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("COMPLETED");
    expect(fixture_.requests.filter(({ stage }) => stage === "clustering")).toHaveLength(1);
  });

  it("preserves conflicting structural proposals and completes with explicit unresolved coverage", async () => {
    const { create, config, verificationInputs, plannerContexts } = await fixture({ conflictingReview: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    // The verification question and the plan read the unresolved operations that involve their own candidate.
    expect(verificationInputs.map(({ candidateId, unresolvedPeerOperations }) => unresolvedPeerOperations.map(({ candidateIds }) => candidateIds.includes(candidateId)))).toEqual([[true]]);
    expect(plannerContexts.map(({ unresolvedPeerOperations }) => unresolvedPeerOperations.length)).toEqual([1]);
    // The question's activity is named after that input, so a run resumed from a build that sent other input asks again.
    const contexts = await Promise.all((await core.artifacts(result.runId)).filter(({ kind }) => kind.startsWith("model-context-")).map(async ({ artifactId }) => JSON.parse((await core.artifact(result.runId, artifactId) as { content: string }).content) as { activityId: string }));
    expect(contexts.map(({ activityId }) => activityId).filter((id) => id.startsWith("verification/"))).toEqual([`verification/${verificationInputs[0]?.candidateId}/question`]);
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

  it("asks a verification question that fits no usual size as required input", async () => {
    const usual = await fixture();
    const first = usual.create(); const measured = await first.run(usual.config);
    const question = async (core: typeof first, runId: string) => (await Promise.all((await core.artifacts(runId)).filter(({ kind }) => kind.startsWith("model-context-")).map(async ({ artifactId }) => JSON.parse((await core.artifact(runId, artifactId) as { content: string }).content) as { activityId: string; estimatedTokens: number; admittedAsRequiredInput: boolean }))).find(({ activityId }) => activityId.startsWith("verification/"));
    const usualQuestion = await question(first, measured.runId);
    expect(usualQuestion).toMatchObject({ admittedAsRequiredInput: false });
    // A verifier whose usual size holds about 60% of the question: too small to pack it, large enough to admit it.
    const bytes = (usualQuestion?.estimatedTokens ?? 0) - 2_000;
    const { create, config, requests } = await fixture({ verifierContextTokens: Math.ceil((0.6 * bytes + 2_000) / 0.8) });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "verification")).toHaveLength(1);
    expect(await question(core, result.runId)).toMatchObject({ admittedAsRequiredInput: true });
  });

  it("leaves a candidate unverified when its verification question cannot fit the verifier's context", async () => {
    // Too small for the output allowance alone, so the question cannot be sent even as required input.
    const { create, config, requests } = await fixture({ verifierContextTokens: 2_600 });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "verification")).toHaveLength(0);
    const canonical = (await core.artifacts(result.runId)).find(({ kind }) => kind === "canonical-issues");
    const value = JSON.parse((await core.artifact(result.runId, canonical?.artifactId ?? "") as { content: string }).content) as { limitations: string[] };
    expect(value.limitations).toContain("verification_question_exceeds_context:1");
  });

  it("drops a reviewer's reply that stays invalid after its repair and reports degraded review coverage", async () => {
    const { create, config, requests } = await fixture({ invalidReview: true });
    (config.workflow["modelExecution"] as { maximumOutputRepairs: number }).maximumOutputRepairs = 1;
    const core = create(); const result = await core.run(config);
    expect(result.state).toBe("COMPLETED");
    // The invalid reviewer was asked once more per round, then its reply was set aside.
    expect(requests.filter(({ stage, url }) => stage === "review" && url.includes("auditor-c")).length).toBe(2 * requests.filter(({ stage, url }) => stage === "review" && url.includes("auditor-a")).length);
    const artifacts = await core.artifacts(result.runId);
    expect(artifacts.some(({ kind }) => kind.startsWith("peer-review-rejected-"))).toBe(true);
    const canonical = artifacts.find(({ kind }) => kind === "canonical-issues");
    const value = JSON.parse((await core.artifact(result.runId, canonical?.artifactId ?? "") as { content: string }).content) as { limitations: string[]; coverage: { complete: boolean } };
    expect(value.limitations.some((limitation) => limitation.startsWith("peer_review_output_rejected:"))).toBe(true);
    expect(value.coverage.complete).toBe(false);
  });

  it("sends a review's output repair with less of the source its first attempt carried when the repair would not fit beside it", async () => {
    // Observed live (P20 pilot): a review carried source up to its limit, the repair of its reply appended the reason
    // and the rejected reply to all of it, and the run failed with MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED.
    const { create, config, requests } = await fixture({ invalidReview: true, packedReviewSource: true });
    (config.workflow["modelExecution"] as { maximumOutputRepairs: number }).maximumOutputRepairs = 1;
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(requests.filter(({ stage, url }) => stage === "review" && url.includes("auditor-c")).length).toBe(2 * requests.filter(({ stage, url }) => stage === "review" && url.includes("auditor-a")).length);
    const contexts = await Promise.all((await core.artifacts(result.runId)).filter(({ kind }) => kind.startsWith("model-context-")).map(async ({ artifactId }) => JSON.parse((await core.artifact(result.runId, artifactId) as { content: string }).content) as { activityId: string; fullPaths: string[]; omittedPaths: string[]; estimatedTokens: number; maximumEstimatedTokens: number }));
    const repairs = contexts.filter(({ activityId }) => activityId.startsWith("peer-review/1/auditor-c") && activityId.endsWith("/repair-1"));
    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) {
      const first = contexts.find(({ activityId }) => activityId === repair.activityId.slice(0, -"/repair-1".length));
      // The first attempt left source out, so its prompt was packed; the repair carries less of it, and fits.
      expect(first?.omittedPaths.length).toBeGreaterThan(0);
      expect(repair.fullPaths.length).toBeLessThan(first?.fullPaths.length ?? 0);
      expect(repair.fullPaths).toContain("a.ts");
      expect(repair.estimatedTokens).toBeLessThanOrEqual(repair.maximumEstimatedTokens);
    }
  });

  it("shows a reviewer its earlier votes and has it repair a vote changed on the same evidence", async () => {
    const { create, config, reviewInputs } = await fixture({ voteFlip: "repairs" });
    (config.workflow["modelExecution"] as { maximumOutputRepairs: number }).maximumOutputRepairs = 1;
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(reviewInputs.filter(({ input }) => input.round === 1).every(({ input }) => input.yourEarlierVotes === undefined)).toBe(true);
    const later = reviewInputs.filter(({ url, input, repair }) => url.includes("auditor-b") && input.round === 2 && !repair);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every(({ input }) => Object.values(input.yourEarlierVotes?.votes ?? {}).length > 0 && Object.values(input.yourEarlierVotes?.votes ?? {}).every(({ vote, citedEvidenceIds }) => vote === "reject" && citedEvidenceIds.length > 0))).toBe(true);
    expect(reviewInputs.some(({ url, repair }) => url.includes("auditor-b") && repair)).toBe(true);
    expect((await core.artifacts(result.runId)).some(({ kind }) => kind.startsWith("peer-review-rejected-"))).toBe(false);
  });

  it("sets aside a vote changed on the same evidence instead of failing the run", async () => {
    const { create, config } = await fixture({ voteFlip: "persists" });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const rejected = artifacts.find(({ kind }) => kind.startsWith("peer-review-rejected-"));
    if (rejected === undefined) throw new Error("REJECTED_REVIEW_ABSENT");
    expect(JSON.parse((await core.artifact(result.runId, rejected.artifactId) as { content: string }).content)).toMatchObject({ round: 2, auditorId: "auditor-b", reason: expect.stringContaining("PEER_VOTE_CHANGED_WITHOUT_NEW_EVIDENCE") });
    const canonical = artifacts.find(({ kind }) => kind === "canonical-issues");
    const value = JSON.parse((await core.artifact(result.runId, canonical?.artifactId ?? "") as { content: string }).content) as { limitations: string[] };
    expect(value.limitations.some((limitation) => limitation.startsWith("peer_review_output_rejected:"))).toBe(true);
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
    // Zero rounds replays the same discovery without peer review (the design audit's experiment 11).
    const reviews = requests.filter(({ stage }) => stage === "review").length;
    expect(reviews).toBeGreaterThan(0);
    const withoutReview = await core.replay(source.runId, { consensusPolicy: "risk_weighted", maximumRounds: 0, criticEnabled: true });
    expect(withoutReview.state).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "review")).toHaveLength(reviews);
    expect(requests.filter(({ stage }) => stage === "discovery")).toHaveLength(3);
    expect(requests.filter(({ stage }) => stage === "planner")).toHaveLength(3);
  });

  it("replays the stages after discovery with another verifier, from an identical checkout, and keeps what made discovery", async () => {
    const { create, config, requests, directory } = await fixture();
    const core = create(); const source = await core.run(config);
    expect(source.state).toBe("COMPLETED");
    const hosts = (from: number, stage: string) => [...new Set(requests.slice(from).filter((request) => request.stage === stage).map(({ url }) => new URL(url).hostname))];
    expect(hosts(0, "verification")).toEqual(["auditor-b.example"]);
    const execution = config.workflow["modelExecution"] as Record<string, unknown>;
    const swapped = runConfigSchema.parse({ ...config, workflow: { ...config.workflow, modelExecution: { ...execution, roles: { ...(execution["roles"] as Record<string, string>), verifier: "auditor-c" } } } });
    // The project moved on; a copy of what the source audited stands in for it.
    const checkout = await mkdtemp(join(tmpdir(), "arbitra-model-run-checkout-")); directories.push(checkout);
    await cp(join(directory, "a.ts"), join(checkout, "a.ts"));
    const before = requests.length;
    const replay = await core.replay(source.runId, { mode: "audit", consensusPolicy: "risk_weighted", maximumRounds: 0, criticEnabled: true, configuration: swapped, repository: checkout });
    expect(replay.state).toBe("COMPLETED");
    expect(requests.slice(before).filter(({ stage }) => stage === "discovery")).toHaveLength(0);
    expect(hosts(before, "verification")).toEqual(["auditor-c.example"]);
    expect(await create().overview(replay.runId)).toMatchObject({ repository: checkout });
    // Discovery is reused, so what produced it cannot change, and another checkout must hold the same files.
    const replayOf = (configuration: RunConfig, repository?: string) => core.replay(source.runId, { mode: "audit", consensusPolicy: "risk_weighted", maximumRounds: 0, criticEnabled: true, configuration, ...(repository === undefined ? {} : { repository }) });
    const auditor = swapped.models["auditor-a"]; if (auditor === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
    await expect(replayOf(runConfigSchema.parse({ ...swapped, models: { ...swapped.models, "auditor-a": { ...auditor, modelId: "another-model" } } }))).rejects.toThrow("REPLAY_CONFIGURATION_CHANGES_DISCOVERY:models.auditor-a");
    await expect(replayOf(runConfigSchema.parse({ ...swapped, scope: { kind: "module", modules: ["src"] } }))).rejects.toThrow("REPLAY_CONFIGURATION_CHANGES_DISCOVERY:scope");
    await expect(replayOf(runConfigSchema.parse({ ...swapped, workflow: { ...swapped.workflow, preset: "audit-balanced" } }))).rejects.toThrow("REPLAY_CONFIGURATION_CHANGES_DISCOVERY:workflow.preset");
    await writeFile(join(checkout, "a.ts"), "const value = 1;\n", "utf8");
    await expect(replayOf(swapped, checkout)).rejects.toThrow(`RUN_REPOSITORY_CHANGED:${source.runId}`);
  });

  it("suspends budget exhaustion without dispatch and survives a restart", async () => {
    const { create, config, requests } = await fixture();
    const execution = config.workflow["modelExecution"] as Record<string, unknown>;
    const bounded = runConfigSchema.parse({ ...config, workflow: { ...config.workflow, modelExecution: { ...execution, maximumTokens: 2_000 } } });
    const core = create(); const result = await core.run(bounded);
    expect(result.state).toBe("SUSPENDED_BUDGET"); expect(requests).toHaveLength(0);
    const resumed = create(); await resumed.resume(result.runId);
    expect((await resumed.wait(result.runId)).state).toBe("SUSPENDED_BUDGET"); expect(requests).toHaveLength(0);
    // A limit is only raised, and a raised one lets the paused run go on to the end.
    await expect(resumed.resume(result.runId, { maximumTokens: 1_000 })).rejects.toThrow("TOKEN_LIMIT_NOT_RAISED");
    await resumed.resume(result.runId, { maximumTokens: 50_000_000 });
    const finished = await resumed.wait(result.runId); const events = []; for await (const event of resumed.events(result.runId)) events.push(event);
    expect(finished.state, JSON.stringify(events.slice(-3))).toBe("COMPLETED"); expect(requests.length).toBeGreaterThan(0);
  });

  it("puts every candidate the review left undecided to the verifier, side by side", async () => {
    // Observed live (P20 pilot): with two questions a run, 48 of 50 undecided items stayed open and 17 were never looked at.
    const { create, config, requests, verificationFlight } = await fixture({ largePeerContext: true });
    (config.workflow["modelExecution"] as { maximumParallelCalls?: number }).maximumParallelCalls = 4;
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const read = async <T>(kind: string) => { const descriptor = (await core.artifacts(result.runId)).find((artifact) => artifact.kind === kind); return JSON.parse((await core.artifact(result.runId, descriptor?.artifactId ?? "") as { content: string }).content) as T; };
    const metrics = await read<{ itemCount: number; modelCalls: number; deferredItemIds: string[] }>("verification-metrics");
    // One reviewer rejects and the others accept, so the review decides nothing and every candidate is asked about.
    expect(metrics.itemCount).toBeGreaterThan(1);
    expect(metrics).toMatchObject({ modelCalls: metrics.itemCount, deferredItemIds: [] });
    expect(requests.filter(({ stage }) => stage === "verification")).toHaveLength(metrics.itemCount);
    expect(verificationFlight.most).toBeGreaterThan(1);
    // By default no candidates of different review batches are compared for a merge.
    expect(requests.some(({ stage }) => stage === "merge-check")).toBe(false);
    const issues = await read<{ issues: { disposition: string; verificationOutcome: string | null }[] }>("canonical-issues");
    expect(issues.issues.every(({ disposition, verificationOutcome }) => disposition === "accepted" && verificationOutcome === "CONFIRMED")).toBe(true);
  });

  it("verifies a candidate the reviewers all accepted, asking about its places and not its finders", async () => {
    const { create, config, verificationInputs } = await fixture({ unanimousReview: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const consensus = JSON.parse((await core.artifact(result.runId, (await core.artifacts(result.runId)).find(({ kind }) => kind === "consensus-state")?.artifactId ?? "") as { content: string }).content) as { consensus: { candidates: { outcome: string }[] } };
    expect(consensus.consensus.candidates.map(({ outcome }) => outcome)).toEqual(["accepted"]);
    // The vote accepted it, and it is still checked against the source.
    expect(verificationInputs).toHaveLength(1);
    expect(verificationInputs[0]?.question).toBe("Does the source show the defect the supplied findings describe at a.ts:1?");
    // The verifier reads what each finding claims, not who found it nor how sure the finder was.
    const presented = verificationInputs[0]?.findings ?? [];
    expect(presented.length).toBeGreaterThan(0);
    expect(presented.every((finding) => finding["findingRef"] !== undefined && finding["severity"] === undefined && finding["confidence"] === undefined && finding["status"] === undefined && finding["sourceFindingId"] === undefined)).toBe(true);
    expect(JSON.stringify(presented)).not.toMatch(/auditor-[abc]/u);
  });

  it("plans only the accepted issues of the run's minimum severity, ranked, and lists the rest", async () => {
    const { create, config, criticIssueIds } = await fixture({ largePeerContext: true, severities: ["low", "high", "low", "critical"] });
    (config.workflow["modelExecution"] as { planScope?: { minimumSeverity: string } }).planScope = { minimumSeverity: "high" };
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    // The list is ranked most severe first.
    const issues = await read<{ issues: { candidateId: string; severity: string; disposition: string }[] }>("canonical-issues");
    expect(issues.issues.map(({ severity }) => severity)).toEqual(["critical", "high", "low", "low"]);
    expect((await read<{ rank: number }[]>("issue-ranking")).map(({ rank }) => rank)).toEqual([1, 2, 3, 4]);
    const high = issues.issues.filter(({ severity }) => severity !== "low").map(({ candidateId }) => candidateId);
    const plan = await read<{ acceptedIssueIds: string[] }>("plan-ir");
    expect([...plan.acceptedIssueIds].sort()).toEqual([...high].sort());
    expect(await read<{ notPlanned: { severity: string }[] }>("plan-scope")).toMatchObject({ minimumSeverity: "high", notPlanned: [{ severity: "low" }, { severity: "low" }] });
    // The critic reads the issues the plan covers.
    expect(criticIssueIds.every((ids) => ids.every((id) => high.includes(id)))).toBe(true);
  });

  it("verifies only the issues the plan covers when asked to, leaving the others to the peer vote", async () => {
    const { create, config, verificationInputs } = await fixture({ largePeerContext: true, severities: ["low", "high", "low", "critical"] });
    (config.workflow["modelExecution"] as { planScope?: { minimumSeverity: string } }).planScope = { minimumSeverity: "high" };
    const verifying = { ...config, verification: { ...config.verification, belowPlanScope: "skip" } };
    const core = create(); const result = await core.run(verifying);
    expect(result.state).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    const issues = await read<{ issues: { candidateId: string; severity: string; verificationOutcome: string | null }[]; limitations: string[] }>("canonical-issues");
    const low = issues.issues.filter(({ severity }) => severity === "low");
    expect(low.map(({ verificationOutcome }) => verificationOutcome)).toEqual([null, null]);
    expect(issues.issues.filter(({ severity }) => severity !== "low").every(({ verificationOutcome }) => verificationOutcome !== null)).toBe(true);
    expect((await read<{ candidateIds: string[] }>("verification-below-plan-scope")).candidateIds.sort()).toEqual(low.map(({ candidateId }) => candidateId).sort());
    expect(issues.limitations).toContain("verification_skipped_below_plan_scope:2");
    expect(verificationInputs.length).toBeGreaterThan(0);
  });

  it.each([["one", "high"], ["two", "low"]] as const)("keeps an issue in the plan's scope unless two reviewers lower it below: lowered by %s", async (lowered, severity) => {
    // Observed live (rokavatar): 25 issues found at medium or higher were lowered to low by one reviewer each, so they
    // were neither verified nor planned.
    const { create, config, verificationInputs } = await fixture({ lowerSeverity: lowered });
    (config.workflow["modelExecution"] as { planScope?: { minimumSeverity: string } }).planScope = { minimumSeverity: "medium" };
    const core = create(); const result = await core.run({ ...config, verification: { ...config.verification, belowPlanScope: "skip" } });
    expect(result.state).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    const issues = (await read<{ issues: { candidateId: string; severity: string; verificationOutcome: string | null }[] }>("canonical-issues")).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.severity === severity)).toBe(true);
    if (lowered === "one") {
      expect(issues.every(({ verificationOutcome }) => verificationOutcome !== null)).toBe(true);
      expect(await read<{ issues: unknown[] }>("severity-restored")).toMatchObject({ minimumSeverity: "medium", issues: issues.map(({ candidateId }) => ({ candidateId, foundAs: "high", loweredTo: "low", by: "auditor-a", reason: "Fixture: only a developer path" })) });
    } else {
      expect(verificationInputs).toHaveLength(0);
      expect(artifacts.some(({ kind }) => kind === "severity-restored")).toBe(false);
    }
  });

  it.each([["CONFIRMED", "needs_verification"], ["REJECTED", "rejected"]] as const)("asks a second model before rejecting a severe issue a reviewer backed: second answer %s", async (second, disposition) => {
    // Observed live (rokavatar): 12 critical or high issues a reviewer backed were rejected by one question.
    const { create, config, requests } = await fixture({ severeRejection: second });
    const core = create(); const result = await core.run({ ...config, verification: { ...config.verification, secondOpinion: "severe_rejections" } });
    expect(result.state).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    const issues = (await read<{ issues: { candidateId: string; disposition: string }[] }>("canonical-issues")).issues;
    expect(issues.map((issue) => issue.disposition)).toEqual(issues.map(() => disposition));
    expect(requests.filter(({ stage, url }) => stage === "verification" && url.includes("auditor-c"))).toHaveLength(issues.length);
    const [issue] = issues;
    expect(await read(`verification-second-opinion-${issue?.candidateId ?? ""}`)).toMatchObject({ modelProfileId: "auditor-c", first: { outcome: "REJECTED" }, second: { outcome: second } });
  });

  it("asks a second model before rejecting any severe issue when no peer review ran", async () => {
    // Observed live (blog replay without review, October 22): 7 severe rejections, none asked a second time.
    const { create, config } = await fixture({ severeRejection: "CONFIRMED" });
    const core = create(); const result = await core.run({ ...config, maxConsensusRounds: 0, verification: { ...config.verification, secondOpinion: "severe_rejections" } });
    expect(result.state).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    expect(artifacts.filter(({ kind }) => kind.startsWith("verification-second-opinion-")).length).toBeGreaterThan(0);
  });

  it("asks about each place of a rejected merge on its own, and keeps the place that holds", async () => {
    // Observed live (P20 pilot): a merge gave a real defect another finding's title, and the question was rejected.
    const { create, config, verificationInputs } = await fixture({ ambiguousClustering: true, verificationByPlace: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    // The merged question names three places and is rejected; each place is then asked about in order.
    expect(verificationInputs.map(({ question }) => question)).toEqual([
      "Does the source show the defect the supplied findings describe at a.ts:1, a.ts:2, a.ts:3?",
      "Does the source show the defect the supplied findings describe at a.ts:1?",
      "Does the source show the defect the supplied findings describe at a.ts:2?",
      "Does the source show the defect the supplied findings describe at a.ts:3?",
    ]);
    const places = artifacts.filter(({ kind }) => kind.startsWith("verification-places-"));
    expect(places).toHaveLength(1);
    const issues = await read<{ issues: { disposition: string; verificationOutcome: string; sourceFindingIds: string[] }[] }>("canonical-issues");
    expect(issues.issues.map(({ disposition, verificationOutcome, sourceFindingIds }) => [disposition, verificationOutcome, sourceFindingIds])).toEqual([["accepted", "CONFIRMED", ["auditor-b/1"]]]);
    expect(await read<Record<string, string[]>>("verification-held-findings")).toEqual({ [Object.keys(await read<Record<string, string[]>>("verification-held-findings"))[0] ?? ""]: ["auditor-b/1"] });
  });

  it("asks about every place of a rejected merge, and keeps each place that holds", async () => {
    // Self-audit (October 19, 2026): recovery stopped at the first place confirmed, so a merge of two real defects kept one.
    const { create, config, verificationInputs } = await fixture({ ambiguousClustering: true, verificationByPlace: true, holdingPlaces: ["a.ts:1", "a.ts:3"] });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    expect(verificationInputs.map(({ question }) => question?.replace(/^.* at /u, ""))).toEqual(["a.ts:1, a.ts:2, a.ts:3?", "a.ts:1?", "a.ts:2?", "a.ts:3?"]);
    const issues = await read<{ issues: { disposition: string; verificationOutcome: string; sourceFindingIds: string[] }[] }>("canonical-issues");
    expect(issues.issues.map(({ disposition, verificationOutcome, sourceFindingIds }) => [disposition, verificationOutcome, sourceFindingIds])).toEqual([["accepted", "CONFIRMED", ["auditor-a/1", "auditor-c/1"]]]);
  });

  it("asks about each place of a rejected merge on its own when the merge was asked about in a group", async () => {
    // Self-audit (October 19, 2026): a grouped answer was never re-asked place by place, so a rejected merge lost the
    // defect at its other places whenever questions shared calls.
    const { create, config, verificationInputs } = await fixture({ ambiguousClustering: true, verificationByPlace: true, placeBesideMerge: true });
    config.verification = { ...config.verification, maxQuestionsPerCall: 3 };
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    expect((await read<{ candidateIds: string[] }[]>("verification-groups")).map(({ candidateIds }) => candidateIds.length)).toEqual([2]);
    // Both questions are answered together; the rejected merge is then asked about place by place.
    expect(verificationInputs.slice(2).map(({ question }) => question?.replace(/^.* at /u, ""))).toEqual(["a.ts:1?", "a.ts:2?", "a.ts:3?"]);
    const issues = (await read<{ issues: { disposition: string; sourceFindingIds: string[] }[] }>("canonical-issues")).issues;
    expect(issues.map(({ disposition, sourceFindingIds }) => [disposition, sourceFindingIds]).sort()).toEqual([["accepted", ["auditor-b/1"]], ["rejected", ["auditor-a/2"]]]);
  });

  it.each([
    ["the re-asks of a rejected merge's places", { ambiguousClustering: true, verificationByPlace: true }, {}, 2, 2],
    ["a second opinion", { severeRejection: "CONFIRMED" }, { secondOpinion: "severe_rejections" }, 1, 1],
    ["a failed group's questions asked one at a time", { largePeerContext: true, invalidGroupVerification: true }, { maxQuestionsPerCall: 3 }, 4, 1],
  ] as const)("keeps %s within the run's question limit", async (_, options, settings, limit, notAsked) => {
    // Self-audit (October 19, 2026): only each candidate's first question counted against `maxModelQuestionsPerRound`.
    const { create, config, requests } = await fixture(options);
    const core = create(); const result = await core.run({ ...config, verification: { ...config.verification, ...settings, maxModelQuestionsPerRound: limit } });
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    // A failed group was one question; its repairs are not questions.
    const groupCalls = artifacts.filter(({ kind }) => kind.startsWith("verification-group-split-")).length;
    expect(requests.filter(({ stage }) => stage === "verification").length + groupCalls).toBe(limit);
    expect(await read<unknown[]>("verification-questions-not-asked")).toHaveLength(notAsked);
    expect((await read<{ limitations: string[] }>("canonical-issues")).limitations).toContain(`verification_questions_not_asked:${notAsked}`);
  });

  it("leaves a severe rejection open when the question limit leaves no second opinion", async () => {
    const { create, config, requests } = await fixture({ severeRejection: "REJECTED" });
    const core = create(); const result = await core.run({ ...config, verification: { ...config.verification, secondOpinion: "severe_rejections", maxModelQuestionsPerRound: 1 } });
    expect(result.state).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    expect(requests.filter(({ stage, url }) => stage === "verification" && url.includes("auditor-c"))).toHaveLength(0);
    expect((await read<{ issues: { disposition: string }[] }>("canonical-issues")).issues.map(({ disposition }) => disposition)).toEqual(["needs_verification"]);
  });

  it("puts questions whose claims cite the same files in one call when the run allows it, and answers each on its own", async () => {
    const { create, config, requests } = await fixture({ largePeerContext: true });
    config.verification = { ...config.verification, maxQuestionsPerCall: 3 };
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const read = async <T>(kind: string) => { const descriptor = (await core.artifacts(result.runId)).find((artifact) => artifact.kind === kind); return JSON.parse((await core.artifact(result.runId, descriptor?.artifactId ?? "") as { content: string }).content) as T; };
    const metrics = await read<{ itemCount: number; modelCalls: number; modelQuestionCalls: number }>("verification-metrics");
    const groups = await read<{ candidateIds: string[] }[]>("verification-groups");
    // The claims cite the fixture's files, so questions share calls, three at most, and every question is in one group.
    expect(groups.every(({ candidateIds }) => candidateIds.length >= 1 && candidateIds.length <= 3)).toBe(true);
    expect(groups.length).toBeLessThan(metrics.itemCount);
    expect(new Set(groups.flatMap(({ candidateIds }) => candidateIds)).size).toBe(metrics.itemCount);
    expect(metrics).toMatchObject({ modelCalls: metrics.itemCount, modelQuestionCalls: groups.length });
    expect(requests.filter(({ stage }) => stage === "verification-group" || stage === "verification")).toHaveLength(groups.length);
    const issues = await read<{ issues: { verificationOutcome: string | null }[] }>("canonical-issues");
    expect(issues.issues.every(({ verificationOutcome }) => verificationOutcome === "CONFIRMED")).toBe(true);
  });

  it("shows a group's questions their evidence and locations under neutral names, and reads the answers back under the real ones", async () => {
    // Self-audit (October 19, 2026): a grouped call carried the finder-named IDs a single question renames.
    const { create, config, verificationInputs } = await fixture({ largePeerContext: true });
    config.verification = { ...config.verification, maxQuestionsPerCall: 3 };
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const read = async <T>(kind: string) => { const descriptor = (await core.artifacts(result.runId)).find((artifact) => artifact.kind === kind); return JSON.parse((await core.artifact(result.runId, descriptor?.artifactId ?? "") as { content: string }).content) as T; };
    const grouped = verificationInputs.filter(({ request }) => request !== undefined);
    expect(grouped.length).toBeGreaterThan(1);
    expect(JSON.stringify(grouped.map(({ request, findings }) => [request, findings]))).not.toMatch(/auditor-[abc]/u);
    // The answers cite the neutral names and are taken as given; what is recorded is the finders' evidence.
    expect((await core.artifacts(result.runId)).some(({ kind }) => kind.startsWith("verification-group-split-"))).toBe(false);
    const operations = await read<{ citedEvidenceIds: string[] }[]>("verification-operations");
    expect(operations.flatMap(({ citedEvidenceIds }) => citedEvidenceIds).every((id) => /^auditor-[abc]\/\d+\/evidence\/auditor-[abc]-E\d+$/u.test(id))).toBe(true);
    expect(operations.every(({ citedEvidenceIds }) => citedEvidenceIds.length === 3)).toBe(true);
  });

  it("asks a verification question for no more than an answer takes, and a group for that much a question", async () => {
    // Observed (nextra replay with Sonnet verifying, October 24, 2026): one question wrote to the 128,000-token ceiling.
    const { create, config, requests } = await fixture({ largePeerContext: true });
    (config.workflow["modelExecution"] as { maximumOutputTokens: number }).maximumOutputTokens = 64_000;
    config.verification = { ...config.verification, maxQuestionsPerCall: 3 };
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const groups = JSON.parse((await core.artifact(result.runId, (await core.artifacts(result.runId)).find(({ kind }) => kind === "verification-groups")?.artifactId ?? "") as { content: string }).content) as { candidateIds: string[] }[];
    expect(groups.map(({ candidateIds }) => candidateIds.length)).toEqual([3, 1]);
    expect(requests.filter(({ stage }) => stage === "discovery").map(({ ceiling }) => ceiling)).toEqual([64_000, 64_000, 64_000]);
    expect(requests.filter(({ stage }) => stage === "verification-group").map(({ ceiling }) => ceiling)).toEqual([48_000]);
    expect(requests.filter(({ stage }) => stage === "verification").map(({ ceiling }) => ceiling)).toEqual([16_000]);
  });

  it("asks a group's questions one at a time when the group's answer stays invalid", async () => {
    const { create, config, requests } = await fixture({ largePeerContext: true, invalidGroupVerification: true });
    config.verification = { ...config.verification, maxQuestionsPerCall: 3 };
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    const read = async <T>(kind: string) => JSON.parse((await core.artifact(result.runId, artifacts.find((artifact) => artifact.kind === kind)?.artifactId ?? "") as { content: string }).content) as T;
    const groups = (await read<{ candidateIds: string[] }[]>("verification-groups")).filter(({ candidateIds }) => candidateIds.length > 1);
    expect(groups.length).toBeGreaterThan(0);
    expect(artifacts.filter(({ kind }) => kind.startsWith("verification-group-split-"))).toHaveLength(groups.length);
    // Every grouped question was asked again alone, and answered.
    expect(requests.filter(({ stage }) => stage === "verification")).toHaveLength(groups.flatMap(({ candidateIds }) => candidateIds).length + (await read<{ candidateIds: string[] }[]>("verification-groups")).filter(({ candidateIds }) => candidateIds.length === 1).length);
    const issues = await read<{ issues: { verificationOutcome: string | null }[] }>("canonical-issues");
    expect(issues.issues.every(({ verificationOutcome }) => verificationOutcome === "CONFIRMED")).toBe(true);
  });

  it("gives a verification question only the files its candidate cites", async () => {
    // Observed live (P20 pilot): with the files of the cited files' modules added, each of 51 questions read 47 of
    // a project's 57 files, 5.3M tokens in all.
    const { create, config, verificationInputs } = await fixture({ secondFile: true, conflictingReview: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(verificationInputs.map(({ sourcePaths }) => sourcePaths)).toEqual([["a.ts"]]);
  });

  it("leaves a candidate open when its verification answer stays invalid, and completes the run", async () => {
    const { create, config, requests } = await fixture({ invalidVerification: true });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "verification")).toHaveLength(1);
    const canonical = (await core.artifacts(result.runId)).find(({ kind }) => kind === "canonical-issues");
    const value = JSON.parse((await core.artifact(result.runId, canonical?.artifactId ?? "") as { content: string }).content) as { limitations: string[]; issues: { disposition: string; verificationOutcome: string }[] };
    expect(value.limitations).toContain("verification_question_unanswered:1");
    expect(value.issues.map(({ disposition, verificationOutcome }) => [disposition, verificationOutcome])).toEqual([["needs_verification", "STILL_NEEDS_VERIFICATION"]]);
  });

  it("has one critic pass and one revision by default, and reports what the revision did", async () => {
    // Observed live (P20 pilot): the critic's second reading of a revised plan was 82 calls for remarks no stage read.
    const { create, config, requests, criticIssueIds } = await fixture({ revision: "still_blocking" });
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    expect(requests.filter(({ stage }) => stage === "critic")).toHaveLength(1);
    expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(1);
    const read = async <T>(kind: string) => { const descriptor = (await core.artifacts(result.runId)).find((artifact) => artifact.kind === kind); return JSON.parse((await core.artifact(result.runId, descriptor?.artifactId ?? "") as { content: string }).content) as T; };
    const feedback = await read<{ items: { id: string; blocking: boolean }[]; revision: { rechecked: boolean; resolvedCritiqueItemIds: string[]; notRevisedCritiqueItemIds: string[] } }>("critic-feedback");
    expect(feedback.items.filter(({ blocking }) => blocking)).toHaveLength(1);
    expect(feedback.revision).toEqual({ rechecked: false, resolvedCritiqueItemIds: feedback.items.map(({ id }) => id), notRevisedCritiqueItemIds: [] });
    expect((await read<{ title: string }>("plan-ir")).title).toBe("Revised plan");
    // The critic's blocking item was worked in by the one revision, so it no longer holds the run's gate.
    expect((await core.gate(result.runId)).reasons).not.toContain("blocking_critic_feedback");
    // The critic read the issues the plan resolves, and those only.
    const plan = await read<{ acceptedIssueIds: string[] }>("plan-ir");
    expect(criticIssueIds).toEqual([plan.acceptedIssueIds]);
  });

  it("checks each blocking critique with the critique checker and revises only for the items that hold", async () => {
    for (const verdict of ["DOES_NOT_HOLD", "HOLDS"] as const) {
      const { create, config, requests } = await fixture({ revision: "still_blocking", critiqueVerdict: verdict });
      (config.workflow["modelExecution"] as { roles: Record<string, string> }).roles["critiqueChecker"] = "auditor-b";
      const core = create(); const result = await core.run(config);
      const events = []; for await (const event of core.events(result.runId)) events.push(event);
      expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
      expect(requests.filter(({ stage }) => stage === "critique-check").map(({ url }) => url.includes("auditor-b"))).toEqual([true]);
      const read = async <T>(kind: string) => { const descriptor = (await core.artifacts(result.runId)).find((artifact) => artifact.kind === kind); return JSON.parse((await core.artifact(result.runId, descriptor?.artifactId ?? "") as { content: string }).content) as T; };
      expect(await read<{ verdict: string }[]>("critique-checks")).toMatchObject([{ verdict }]);
      const feedback = await read<{ items: { blocking: boolean; summary: string }[] }>("critic-feedback");
      if (verdict === "DOES_NOT_HOLD") {
        // The item stays in the feedback, not blocking, with the reason; no revision is asked for and the gate is not held.
        expect(feedback.items).toMatchObject([{ blocking: false, summary: expect.stringContaining("does not hold") as unknown }]);
        expect(requests.some(({ stage }) => stage === "revision" || stage === "revision-patch")).toBe(false);
        expect((await core.gate(result.runId)).reasons).not.toContain("blocking_critic_feedback");
      } else {
        expect(feedback.items.filter(({ blocking }) => blocking)).toHaveLength(1);
        expect(requests.filter(({ stage }) => stage === "revision")).toHaveLength(1);
      }
    }
  });

  it("hands off the final plan with each issue's evidence, a failing test first, and a result to report", async () => {
    const { create, config } = await fixture();
    const core = create(); const result = await core.run(config);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const artifacts = await core.artifacts(result.runId);
    expect(artifacts.some(({ kind }) => kind === "implementation-unavailable")).toBe(false);
    const tree = JSON.parse((await core.artifact(result.runId, artifacts.find(({ kind }) => kind === "implementation")?.artifactId ?? "") as { content: string }).content) as Record<string, string>;
    const plan = JSON.parse((await core.artifact(result.runId, artifacts.find(({ kind }) => kind === "plan-ir")?.artifactId ?? "") as { content: string }).content) as { acceptedIssueIds: string[] };
    const [issueId] = plan.acceptedIssueIds;
    const issue = tree[`issues/${issueId}.md`] ?? "";
    expect(issue).toContain("## Where");
    expect(issue).toContain("a.ts:1");
    expect(issue).toContain("const value = null;");
    expect(issue).toContain("Verification: `CONFIRMED`");
    expect(issue).toContain("## Reproduce first");
    expect(JSON.parse(tree["progress.schema.json"] ?? "{}")).toMatchObject({ properties: { issues: { items: { properties: { issueId: { enum: [issueId] }, result: { enum: ["fixed", "not_reproducible", "no_change_needed", "blocked"] } } } } } });
  });

  it("gives the critic only the issues the plan has to resolve", async () => {
    // Observed live (P20 pilot): 71 issues beside a plan for 6 of them were 90 records and 30 critic calls.
    const { create, config, criticIssueIds } = await fixture({ largePeerContext: true });
    const bounded = runConfigSchema.parse({ ...config, verification: { maxModelQuestionsPerRound: 1 } });
    const core = create(); const result = await core.run(bounded);
    const events = []; for await (const event of core.events(result.runId)) events.push(event);
    expect(result.state, JSON.stringify(events.at(-1))).toBe("COMPLETED");
    const canonical = (await core.artifacts(result.runId)).find(({ kind }) => kind === "canonical-issues");
    const issues = (JSON.parse((await core.artifact(result.runId, canonical?.artifactId ?? "") as { content: string }).content) as { issues: { candidateId: string; disposition: string }[] }).issues;
    const accepted = issues.filter(({ disposition }) => disposition === "accepted").map(({ candidateId }) => candidateId);
    expect(accepted).toHaveLength(1); expect(issues.length).toBeGreaterThan(1);
    expect(criticIssueIds).toEqual([accepted]);
  });

  it("runs a checking stage at the effort the run sets for it and sizes calls at the run's bytes a token", async () => {
    const usual = await fixture();
    const first = usual.create(); const measured = await first.run(usual.config);
    const traces = async (core: typeof first, runId: string) => Promise.all((await core.artifacts(runId)).filter(({ kind }) => /^model-activity-[a-f0-9]+-trace$/u.test(kind)).map(async ({ artifactId }) => (JSON.parse((await core.artifact(runId, artifactId) as { content: string }).content) as { terminal: { activityId: string; effortRequested: string | null } }).terminal));
    const contexts = async (core: typeof first, runId: string) => Promise.all((await core.artifacts(runId)).filter(({ kind }) => kind.startsWith("model-context-")).map(async ({ artifactId }) => JSON.parse((await core.artifact(runId, artifactId) as { content: string }).content) as { activityId: string; estimatedTokens: number }));
    const depthEffort = (await traces(first, measured.runId)).find(({ activityId }) => activityId.startsWith("peer-review/"))?.effortRequested;
    expect((await traces(first, measured.runId)).filter(({ activityId }) => !activityId.includes("/discovery")).every(({ effortRequested }) => effortRequested === depthEffort)).toBe(true);
    const { create, config } = await fixture();
    Object.assign(config.workflow["modelExecution"] as object, { stageEffort: { verification: "low", critic: "medium" }, estimatedBytesPerToken: 2 });
    const core = create(); const result = await core.run(config);
    expect(result.state).toBe("COMPLETED");
    const efforts = await traces(core, result.runId);
    expect(efforts.filter(({ activityId }) => activityId.startsWith("verification/")).map(({ effortRequested }) => effortRequested)).toEqual(["low"]);
    expect(efforts.filter(({ activityId }) => activityId.startsWith("critic/")).map(({ effortRequested }) => effortRequested)).toEqual(["medium"]);
    // A stage the run does not name, and discovery always, keep the effort of the audit depth.
    expect(efforts.filter(({ activityId }) => activityId.startsWith("peer-review/") || activityId.includes("/discovery")).every(({ effortRequested }) => effortRequested === depthEffort)).toBe(true);
    // At two bytes a token the same question is counted at about half, beside the unchanged output allowance.
    const question = (list: { activityId: string; estimatedTokens: number }[]) => (list.find(({ activityId }) => activityId.startsWith("verification/"))?.estimatedTokens ?? 0) - 2_000;
    const [once, twice] = [question(await contexts(first, measured.runId)), question(await contexts(core, result.runId))];
    expect(twice).toBeGreaterThan(0);
    expect(Math.abs(once - 2 * twice)).toBeLessThanOrEqual(2);
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
