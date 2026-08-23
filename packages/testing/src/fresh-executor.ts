import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export interface ExecutionResult {
  readonly isolationPassed: boolean;
  readonly handoffAccepted: boolean;
  readonly executorExitCode: number | null;
  readonly verificationExitCode: number;
  readonly transcript: string;
  readonly immutableContractsPreserved: boolean;
}

export interface AuditFixture {
  readonly fixtureId: string;
  readonly repositoryDir: string;
}

export interface FakeModels {
  readonly responses: Readonly<Record<string, unknown>>;
}

export interface AuditAcceptanceResult {
  readonly fixtureId: string;
  readonly stageEvents: readonly string[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly implementationTree: Readonly<Record<string, string>>;
  readonly providerTraces: readonly unknown[];
  readonly peerReview: { readonly rounds: 2; readonly earlyStop: true; readonly roundTwoCandidateIds: readonly ["C-DEFECT"] };
  readonly verification: { readonly resolvedDisputes: 1; readonly modelCalls: 0 };
  readonly critic: { readonly status: "skipped"; readonly degradedReviewCoverage: true };
}

export async function runAuditAcceptance(fixture: AuditFixture, fakeModels: FakeModels): Promise<AuditAcceptanceResult> {
  const events: string[] = []; const artifacts = new Map<string, string>();
  const persist = (path: string, value: unknown) => { artifacts.set(path, `${stableJson(value)}\n`); };
  const repositoryDir = realpathSync(fixture.repositoryDir);
  const sourceAdd = readFileSync(join(repositoryDir, "src", "add.js"), "utf8");
  const sourceFormat = readFileSync(join(repositoryDir, "src", "format.js"), "utf8");
  const testAdd = readFileSync(join(repositoryDir, "test", "add.test.js"), "utf8");
  const packageManifest = readFileSync(join(repositoryDir, "package.json"), "utf8");
  const snapshot = { files: { "src/add.js": fileFact(sourceAdd), "src/format.js": fileFact(sourceFormat) } };
  persist("snapshot.json", snapshot); events.push("snapshot.completed");
  const preflightModule = await loadModule("core", "preflight/project-context");
  const preflightNode = preflightModule.preflight as (snapshot: unknown, config: unknown) => PreflightRun;
  const preflight = preflightNode({
    root: repositoryDir, branch: null, commit: "fixture", dirty: false, changedFiles: [], scope: { kind: "full" }, ignoredPaths: [],
    files: [
      { path: "package.json", content: packageManifest, size: Buffer.byteLength(packageManifest) },
      { path: "src/add.js", content: sourceAdd, size: Buffer.byteLength(sourceAdd) },
      { path: "src/format.js", content: sourceFormat, size: Buffer.byteLength(sourceFormat) },
      { path: "test/add.test.js", content: testAdd, size: Buffer.byteLength(testAdd) },
    ],
    gitLog: "\u001efixture\u001fFixture Author\u001f2026-08-22T00:00:00.000Z\u001ffix addition\u001fsrc/add.js",
  }, { configuredExclusions: [], gate: { riskCategory: "high", securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1, instructionRiskDensity: 0, userSelectedThoroughness: "DEEP", configuredModelCount: 2, budget: null } });
  persist("project-context.json", preflight); events.push("preflight.completed");

  const provider = await fakeProviderRuntime(fakeModels);
  const discoveryModule = await loadModule("workflow", "nodes/discovery/node");
  const discoveryNode = discoveryModule.discoveryNode as (config: unknown, runtime: unknown, store: unknown) => { run(artifacts: readonly unknown[]): Promise<DiscoveryRun> };
  const discovery = discoveryNode({ auditors: auditors().map(({ auditorId }) => ({ auditorId, modelProfileId: auditorId })), depth: "deep", modules: preflight.modules, hotspots: preflight.hotspots, protocol: { protocolId: "production-audit", protocolVersion: "1.0.0", protocolHash: "a".repeat(64) }, nodeTokenBudget: 2_000, structuredEmissionReserveTokens: 100 }, {
    async run(request: unknown) { const reviewer = (request as { auditor: { auditorId: string } }).auditor.auditorId; return provider.invoke(`discovery:${reviewer}`, request); },
  }, { async persist(auditorId: string, result: unknown) { const path = `discovery/${auditorId}.json`; persist(path, result); return path; } });
  const discoveryRun = await discovery.run([
    { kind: "snapshot_identity", provenance: "deterministic", ref: "snapshot.json", tokenEstimate: 10 },
    { kind: "preflight", provenance: "deterministic", ref: "project-context.json", tokenEstimate: 10 },
    { kind: "manifest", provenance: "deterministic", ref: "package.json", tokenEstimate: 5 },
    { kind: "audit_protocol", provenance: "deterministic", ref: "protocol.md", tokenEstimate: 10 },
  ]);
  events.push("discovery.completed");

  const validationModule = await loadModule("workflow", "nodes/validate-findings");
  const validateFindings = validationModule.validateFindings as (submissions: readonly unknown[], snapshot: unknown, footprints: unknown, options: unknown) => Promise<ValidationRun>;
  const submissions = discoveryRun.results.flatMap((result) => result.findings.map((finding) => ({ auditorId: result.auditorId, finding, repairCount: 0 })));
  const footprints = Object.fromEntries(auditors().map(({ auditorId }) => [auditorId, { nodeId: `discover:${auditorId}`, ranges: [{ path: "src/add.js", start: 0, end: 10_000 }, { path: "src/format.js", start: 0, end: 10_000 }] }]));
  const validated = await validateFindings(submissions, snapshot, footprints, { rejectionStore: { async persistRejection() { return "unused"; } } });
  if (validated.rejected.length > 0) throw new Error("HANDOFF_FIXTURE_FINDING_REJECTED");
  persist("validation-summary.json", validated.summaries); events.push("validation.completed");

  const clusteringModule = await loadModule("workflow", "clustering/index");
  const cluster = clusteringModule.cluster as (inputs: readonly unknown[], options: unknown) => Promise<ClusterRun>;
  const clustered = await cluster(validated.accepted, { strategy: clusteringModule.deterministicClusteringStrategy });
  if (clustered.clusters.length !== 2) throw new Error(`HANDOFF_EXPECTED_TWO_CLUSTERS:${clustered.clusters.length}`);
  persist("clusters.json", clustered); events.push("clustering.completed");

  const issueBoardModule = await loadModule("core", "issue-board/projection");
  const projectBoard = issueBoardModule.projectBoard as (operations: readonly unknown[]) => AuditBoard;
  const boardOperations: unknown[] = seedBoardOperations(clustered);
  let board = projectBoard(boardOperations);
  persist("issue-board.json", board); events.push("issue_board.completed");
  const peerModule = await loadModule("workflow", "nodes/peer-review/round");
  const consensusModule = await loadModule("workflow", "consensus/engine");
  const peerReviewRound = peerModule.peerReviewRound as (board: AuditBoard, policy: unknown, round: number, dependencies: unknown) => Promise<PeerRound>;
  const computeConsensus = consensusModule.computeConsensus as (board: AuditBoard, policy: unknown, context: unknown) => ConsensusRun;
  const peerDependencies = { auditors: auditors(), rng: identityRng(), runtime: { async review(request: PeerRequest) { return provider.invoke(`peer:${request.round}:${request.reviewerId}`, request) as Promise<readonly PeerOperation[]>; } } };
  const roundOne = await peerReviewRound(board, consensusModule.DEFAULT_CONSENSUS_POLICY, 1, peerDependencies);
  boardOperations.push(...roundOne.operations); board = projectBoard(boardOperations);
  persist("peer-review-round-1.json", roundOne); events.push("peer_review.round_1.completed");
  const consensusOne = computeConsensus(board, consensusModule.DEFAULT_CONSENSUS_POLICY, { auditors: auditors(), round: 1, maximumRounds: 3 });
  persist("consensus-round-1.json", consensusOne); events.push("consensus.round_1.completed");
  if (consensusOne.candidates.find(({ candidateId }) => candidateId === "C-DEFECT")?.outcome !== "needs_verification") throw new Error("HANDOFF_DISPUTE_NOT_CREATED");

  const verificationModule = await loadModule("workflow", "nodes/verification/engine");
  const verifyItem = verificationModule.verifyItem as (item: unknown, tools: unknown, policy: unknown, dependencies: unknown) => Promise<VerificationResult>;
  const verificationOperations: unknown[] = [];
  const verification = await verifyItem({ candidateId: "C-DEFECT", severity: "high", claim: "Addition subtracts", question: "Does add return subtraction instead of a sum?", citedEvidenceIds: ["EA-D", "EB-D"], citedContext: [{ evidenceId: "EA-D", text: "return left - right" }], symbols: ["add"], routes: [], dependencies: [] }, verificationTools(), { allowModelCall: false }, { sink: { async append(operation: unknown) { verificationOperations.push(operation); } }, round: 1 });
  if (verification.outcome !== "CONFIRMED" || verification.modelCalls !== 0) throw new Error("HANDOFF_DETERMINISTIC_VERIFICATION_FAILED");
  boardOperations.push(verification.operation); board = projectBoard(boardOperations);
  persist("verification.json", { result: verification, operations: verificationOperations }); events.push("verification.completed");

  const unresolvedRoundOneIds = new Set(consensusOne.candidates.filter(({ outcome }) => outcome === "needs_verification").map(({ candidateId }) => candidateId));
  const roundTwoInput = Object.freeze({ candidates: Object.freeze(Object.fromEntries(Object.entries(board.candidates).filter(([candidateId]) => unresolvedRoundOneIds.has(candidateId)))) });
  const roundTwo = await peerReviewRound(roundTwoInput, consensusModule.DEFAULT_CONSENSUS_POLICY, 2, peerDependencies);
  boardOperations.push(...roundTwo.operations); board = projectBoard(boardOperations);
  persist("peer-review-round-2.json", roundTwo); events.push("peer_review.round_2.completed");
  const roundTwoIds = [...new Set(roundTwo.dispatches.flatMap(({ candidateIds }) => candidateIds))].sort();
  if (stableJson(roundTwoIds) !== stableJson(["C-DEFECT"])) throw new Error(`HANDOFF_DELTA_ROUND_LEAK:${roundTwoIds.join(",")}`);
  const consensus = computeConsensus(board, consensusModule.DEFAULT_CONSENSUS_POLICY, { auditors: auditors(), round: 2, maximumRounds: 3 });
  if (consensus.candidates.some(({ outcome }) => outcome === "needs_verification")) throw new Error("HANDOFF_PEER_REVIEW_DID_NOT_STOP_EARLY");
  persist("consensus.json", consensus); events.push("consensus.completed");

  const canonicalModule = await loadModule("workflow", "nodes/canonical-issues");
  const canonicaliseIssues = canonicalModule.canonicaliseIssues as (board: unknown, verification: readonly unknown[], coverage: unknown) => CanonicalIssueSet;
  const canonical = canonicaliseIssues({ candidates: board.candidates, consensus: { auditorCount: auditors().length, candidates: consensus.candidates } }, [{ candidateId: "C-DEFECT", outcome: "CONFIRMED" }], { securityCoverage: { degraded: false, reason: null }, suppressionCandidates: [], unexaminedSurfaces: [], limitations: [] });
  persist("canonical-issues.json", canonical); events.push("canonical_issues.completed");

  const plannerModule = await loadModule("workflow", "nodes/planner/node");
  const plannerNode = plannerModule.plannerNode as (config: unknown) => { run(input: unknown): Promise<{ plan: PlannerPlan; modelCalls: number }> };
  const planner = plannerNode({ protocolVersion: "1.0.0", protocolHash: "b".repeat(64), runtime: { async plan(request: unknown) { return provider.invoke("planner", request); } }, schema: { parse(value: unknown) { return value as PlannerPlan; } } });
  const planned = await planner.run({ projectContext: preflight.projectContext, canonicalIssues: canonical.issues, repositoryContext: [{ ref: "snapshot.json", trust: "derived", content: "bounded fixture context" }], constraints: ["Only derived scope may be rendered"], workflowGoal: "Repair the accepted fixture defect.", premiseReport: { status: "positive", interpretation: "smoke_test_only_not_proof", limitations: ["Scripted fixture is not product-wide proof."] } });
  persist("plan-ir.json", planned.plan); events.push("planner.completed");

  const criticModule = await loadModule("workflow", "nodes/critic/node");
  const criticNode = criticModule.criticNode as (config: unknown) => { run(input: unknown, context: unknown): Promise<CriticResult> };
  const critic = criticNode({ protocolVersion: "1.0.0", protocolHash: "c".repeat(64), runtime: { async critique() { throw new Error("WEAK_CRITIC_MUST_NOT_RUN"); } }, schema: { parse(value: unknown) { return value; } } });
  const criticized = await critic.run({ plan: planned.plan, validationContract: planned.plan.validationContract, canonicalIssues: canonical.issues, necessaryContext: [] }, { requirement: { deepMode: true }, planner: { id: "planner", capability: "frontier", independenceGroup: "planner-group" }, pool: [{ id: "weak-critic", capability: "balanced", independenceGroup: "critic-group", available: true }] });
  if (criticized.status !== "skipped" || !criticized.degradedReviewCoverage) throw new Error("HANDOFF_CRITIC_SKIP_NOT_HONEST");
  persist("critic-selection.json", criticized); events.push("critic.skipped_degraded");
  const revisionModule = await loadModule("workflow", "nodes/revision");
  const revisePlanOnce = revisionModule.revisePlanOnce as (goal: string, plan: PlannerPlan, critique: readonly unknown[], config: unknown, runtime: unknown) => Promise<{ revisionCalls: number }>;
  const revision = await revisePlanOnce("Repair the accepted fixture defect.", planned.plan, [], { id: "planner" }, { async revise() { throw new Error("NON_BLOCKING_REVISION_MUST_NOT_RUN"); } });
  if (revision.revisionCalls !== 0) throw new Error("HANDOFF_UNEXPECTED_REVISION");
  events.push("revision.skipped_non_blocking");

  const manifest = manifestFromPlan(fixture, planned.plan, canonical);
  const renderModule = await loadModule("core", "render/index");
  const renderImplementation = renderModule.renderImplementation as (manifest: unknown, options: unknown) => Readonly<Record<string, string>>;
  const implementationTree = renderImplementation(manifest, { selectedTaskId: "TASK-001", effectiveWriteScopes: { "TASK-001": ["src/add.js"] }, effectiveReadScopes: { "TASK-001": ["src/add.js", "test/add.test.js"] } });
  if (implementationTree["manifest.json"] === undefined || implementationTree["tasks/TASK-001/task.md"] === undefined) throw new Error("HANDOFF_RENDER_INCOMPLETE");
  persist("implementation/manifest.json", JSON.parse(implementationTree["manifest.json"]));
  persist("implementation/tree.json", Object.fromEntries(Object.entries(implementationTree).map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")])));
  events.push("rendering.completed");
  persist("provider-traces.json", provider.traces);

  return Object.freeze({ fixtureId: fixture.fixtureId, stageEvents: Object.freeze(events), artifacts: Object.freeze(Object.fromEntries([...artifacts].sort(([a], [b]) => a.localeCompare(b)))), implementationTree, providerTraces: Object.freeze(provider.traces), peerReview: Object.freeze({ rounds: 2 as const, earlyStop: true as const, roundTwoCandidateIds: Object.freeze(["C-DEFECT"] as const) }), verification: Object.freeze({ resolvedDisputes: 1 as const, modelCalls: 0 as const }), critic: Object.freeze({ status: "skipped" as const, degradedReviewCoverage: true as const }) });
}

/** Scripted isolation regression only. This is explicitly not proof of plan intelligibility. */
export function freshExecutor(repoDir: string, implementationDir: string, extraContext: readonly string[] = []): ExecutionResult {
  if (extraContext.length > 0) throw new Error("FRESH_EXECUTOR_EXTRA_CONTEXT_FORBIDDEN");
  return withIsolatedInputs(repoDir, implementationDir, ({ repository, implementation }) => {
    assertRequiredHandoff(implementation);
    const before = contractHashes(implementation);
    const source = join(repository, "src", "add.js");
    const original = readFileSync(source, "utf8");
    if (!original.includes("return left - right;")) throw new Error("SCRIPTED_FIXTURE_DEFECT_NOT_FOUND");
    writeFileSync(source, original.replace("return left - right;", "return left + right;"), "utf8");
    const verification = runTaskVerification(repository, implementation);
    const after = contractHashes(implementation);
    const immutableContractsPreserved = stableJson(before) === stableJson(after);
    return Object.freeze({ isolationPassed: verification.status === 0 && immutableContractsPreserved, handoffAccepted: false, executorExitCode: 0, verificationExitCode: verification.status, transcript: `scripted isolation executor\n${verification.output}`, immutableContractsPreserved });
  });
}

export function runRealHandoff(executorCommand: string, repoDir: string, implementationDir: string): ExecutionResult {
  const parsed = parseCommand(executorCommand);
  if (parsed === null) throw new Error("INVALID_REAL_HANDOFF_EXECUTOR_COMMAND");
  return withIsolatedInputs(repoDir, implementationDir, ({ root, repository, implementation }) => {
    assertRequiredHandoff(implementation);
    const before = contractHashes(implementation);
    const prompt = "You are a fresh coding agent. Work only in ./repository using ./implementation. Execute TASK-001 from the generated handoff. Do not inspect parent directories or request run history. Finish when TASK-001's deterministic verification passes.";
    const external = spawnSync(parsed.executable, parsed.arguments, { cwd: root, input: prompt, encoding: "utf8", env: releaseEnvironment(), timeout: 15 * 60_000, windowsHide: true });
    const verification = runTaskVerification(repository, implementation);
    const after = contractHashes(implementation);
    const immutableContractsPreserved = stableJson(before) === stableJson(after);
    const transcript = [`executor exit: ${external.status ?? "null"}`, external.stdout ?? "", external.stderr ?? "", "deterministic verification:", verification.output].join("\n");
    return Object.freeze({ isolationPassed: immutableContractsPreserved, handoffAccepted: verification.status === 0 && immutableContractsPreserved, executorExitCode: external.status, verificationExitCode: verification.status, transcript, immutableContractsPreserved });
  });
}

export function writeRenderedTree(tree: Readonly<Record<string, string>>, directory: string): void {
  for (const [path, content] of Object.entries(tree)) { const target = resolve(directory, path); if (!target.startsWith(`${resolve(directory)}${sep}`)) throw new Error("HANDOFF_RENDER_PATH_ESCAPE"); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, "utf8"); }
}

interface DiscoveryRun { readonly results: readonly { readonly auditorId: string; readonly findings: readonly unknown[] }[] }
interface PreflightRun { readonly projectContext: unknown; readonly modules: readonly { readonly id: string; readonly files: readonly string[] }[]; readonly hotspots: readonly { readonly path: string; readonly score: number; readonly rank: number }[] }
interface ValidationRun { readonly accepted: readonly unknown[]; readonly rejected: readonly unknown[]; readonly summaries: readonly unknown[] }
interface ClusterRun { readonly clusters: readonly { readonly sourceFindingIds: readonly string[] }[]; readonly [key: string]: unknown }
interface PeerOperation { readonly operationId: string; readonly candidateId: string; readonly authorId: string; readonly round: number; readonly type: string; readonly citedEvidenceIds: readonly string[]; readonly reason: string }
interface PeerRound { readonly operations: readonly PeerOperation[]; readonly dispatches: readonly { readonly candidateIds: readonly string[] }[] }
interface PeerRequest { readonly reviewerId: string; readonly round: number }
interface AuditCandidate { readonly candidateId: string; readonly claim: { readonly title: string; readonly description: string }; readonly sourceFindingIds: readonly string[]; readonly severity: "high" | "low"; readonly blocker: boolean; readonly status: string; readonly votes: readonly { readonly authorId: string; readonly disposition: "accept" | "reject" | "needs_verification"; readonly citedEvidenceIds: readonly string[]; readonly reason: string }[]; readonly evidence: readonly unknown[]; readonly counterEvidence: readonly unknown[]; readonly firstSeenRound: number; readonly lastChangedRound: number; readonly category: string }
interface AuditBoard { readonly candidates: Readonly<Record<string, AuditCandidate>> }
interface ConsensusRun { readonly candidates: readonly { readonly candidateId: string; readonly outcome: string }[]; readonly [key: string]: unknown }
interface VerificationResult { readonly outcome: string; readonly modelCalls: number; readonly [key: string]: unknown }
interface CanonicalIssueSet { readonly issues: readonly { readonly candidateId: string; readonly disposition: string; readonly claim: { readonly title: string; readonly description: string } }[] }
interface PlannerPlan { readonly acceptedIssueIds: readonly string[]; readonly unresolvedQuestions: readonly unknown[]; readonly validationContract: { readonly validation: readonly { readonly id: string }[] }; readonly tasks: readonly PlannerTask[]; readonly traceability: unknown; readonly routingRecommendations: readonly unknown[]; readonly [key: string]: unknown }
interface PlannerTask { readonly id: string; readonly title: string; readonly goal: { readonly objective: string; readonly doneWhen: readonly string[]; readonly stopWhen: readonly string[]; readonly blockedWhen: readonly string[] }; readonly addresses: { readonly issues: readonly string[]; readonly requirements: readonly string[]; readonly validation: readonly string[] }; readonly routing: { readonly capability: string; readonly effort: string; readonly reason: readonly string[] }; readonly dependencies: { readonly dependsOn: readonly string[]; readonly blocks: readonly string[]; readonly conflictsWith: readonly string[] }; readonly scope: { readonly likelyFiles: readonly string[]; readonly components: readonly string[]; readonly interfaces: readonly string[] }; readonly filesNotToTouch: readonly string[]; readonly readFirst: readonly string[]; readonly context: readonly string[]; readonly invariants: readonly string[]; readonly acceptanceCriteria: readonly string[]; readonly verification: { readonly commands: readonly { readonly command: string; readonly expectedExitCode: number; readonly executionPolicy: string }[] }; readonly rollbackPlan: readonly string[]; readonly escalateIf: readonly string[] }
interface CriticResult { readonly status: string; readonly degradedReviewCoverage: boolean }

function seedBoardOperations(clustered: ClusterRun): unknown[] {
  return clustered.clusters.map((cluster) => {
    const defect = cluster.sourceFindingIds.some((id) => id.endsWith("/DEFECT")); const candidateId = defect ? "C-DEFECT" : "C-DECOY";
    return Object.freeze({ operationId: `cluster:${candidateId}`, candidateId, authorId: "clustering", round: 0, type: "add_candidate", citedEvidenceIds: Object.freeze([]), candidate: Object.freeze({ candidateId, title: defect ? "Addition subtracts" : "Formatter is deliberate", description: defect ? "add uses the wrong arithmetic operator" : "The result prefix is expected", sourceFindingIds: Object.freeze([...cluster.sourceFindingIds]), severity: defect ? "high" as const : "low" as const, blocker: false }) });
  });
}
function verificationTools() {
  const attempt = (method: string, verdict: string) => Object.freeze({ method, verdict, evidenceIds: verdict === "confirmed" ? ["E-VERIFIED"] : [], artifactRefs: [`artifact:${method}`], toolCallIds: [`tool:${method}`], activityId: `activity:${method}`, confidence: verdict === "confirmed" ? 1 : null });
  return { async readCitedLines() { return attempt("cited_lines", "inconclusive"); }, async searchSymbolOrCallPath() { return attempt("symbol_or_call_path", "confirmed"); }, async inspectRouteConfigMiddleware() { return attempt("route_config_middleware", "inconclusive"); }, async inspectDependencyOrImportPath() { return attempt("dependency_or_import_path", "inconclusive"); }, async runAllowlistedSafeTest() { return attempt("allowlisted_safe_test", "inconclusive"); }, async boundedDeterministicCheck() { return attempt("bounded_deterministic_check", "inconclusive"); } };
}
function manifestFromPlan(fixture: AuditFixture, plan: PlannerPlan, canonical: CanonicalIssueSet): unknown {
  const task = plan.tasks[0]!;
  return { manifestVersion: "1.0.0", run: { runId: `audit:${fixture.fixtureId}`, mode: "audit", repository: basename(fixture.repositoryDir), scopeKind: "full", snapshot: { note: "Offline acceptance fixture", files: ["src/add.js", "src/format.js", "test/add.test.js"] }, degradations: [{ field: "critic", reason: "no_qualifying_critic", statement: "Critic coverage is degraded and recorded." }], metrics: { modelCalls: null, tokens: null, cost: null, note: "Fake-model integration does not fabricate real cost." } }, requirements: { assumptions: [], ambiguities: [], acceptance: [{ id: "ACC-001", assertion: "Addition returns the arithmetic sum." }], outOfScope: [] }, unresolvedQuestions: [], issues: canonical.issues.map((issue) => ({ id: issue.candidateId, title: issue.claim.title, description: issue.claim.description, status: issue.disposition, dissent: [], provenance: ["canonical-issues.json"] })), validation: [{ id: "VAL-001", assertion: "The deterministic fixture test passes.", evidence: ["npm test"], addresses: ["ACC-001"] }], phases: [{ id: "P1", title: "Repair", goal: "Correct the known defect." }], tasks: [{ ...task, phase: "P1", outOfScope: [], expectedEvidence: ["npm test output"] }], progressSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["ts", "taskId", "event"], properties: { ts: { type: "string" }, taskId: { type: "string", pattern: "^TASK-[0-9]{3}$" }, event: { enum: ["started", "verification_run", "completed"] } } } };
}
async function fakeProviderRuntime(fakeModels: FakeModels): Promise<{ invoke(activityId: string, payload: unknown): Promise<unknown>; readonly traces: unknown[] }> {
  const runtimeModule = await loadModule("providers", "runtime"); const schedulerModule = await loadModule("providers", "scheduler"); const continuationModule = await loadModule("providers", "continuation/store");
  const traces: unknown[] = []; const stored = new Map<string, unknown>();
  const TransportRuntime = runtimeModule.ProviderInvocationRuntime as new(options: unknown) => { invoke(request: unknown, context: unknown): Promise<{ structured: unknown }> };
  const Scheduler = schedulerModule.RateLimitScheduler as new(policies: unknown, clock: unknown) => unknown;
  const Continuation = continuationModule.ContinuationStateStore as new(backend: unknown, options: unknown) => unknown;
  const transport = { id: "fixture", async send(request: { messages: readonly { content: string }[] }) { const envelope = JSON.parse(request.messages[0]?.content ?? "{}") as { activityId: string }; if (!Object.hasOwn(fakeModels.responses, envelope.activityId)) throw new Error(`MISSING_FAKE_MODEL_RESPONSE:${envelope.activityId}`); return { text: null, structured: fakeModels.responses[envelope.activityId], toolCalls: [], refusal: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, continuation: null, structuredOutputTier: "native_structured", providerRequestId: `fixture:${envelope.activityId}` }; } };
  const runtime = new TransportRuntime({ transports: { fixture: transport }, scheduler: new Scheduler({ fixture: { rpm: 100, tpm: 100_000, maxConcurrent: 10 } }, { now: () => 0, sleep: async () => {} }), budget: { reserve: () => ({ allowed: true }), recordActual: () => {} }, continuation: new Continuation({ async save(key: string, value: unknown) { stored.set(key, value); }, async load(key: string) { return stored.get(key) ?? null; } }, { enabled: true, now: () => 0 }), traces: { record(trace: unknown) { traces.push(trace); } }, timer: { timeout() { return () => {}; }, sleep: async () => {} } });
  return Object.freeze({ traces, async invoke(activityId: string, payload: unknown) { const response = await runtime.invoke({ modelId: "fixture-model", messages: [{ role: "user", content: JSON.stringify({ activityId, payload }) }], maximumOutputTokens: 2_000 }, { activityId, providerId: "fixture", transportId: "fixture", modelId: "fixture-model", estimatedTokens: 10, maximumRetries: 0, timeoutMs: 1_000, signal: new AbortController().signal }); return response.structured; } });
}
function withIsolatedInputs<T>(repoDir: string, implementationDir: string, operation: (paths: { root: string; repository: string; implementation: string }) => T): T {
  const sources = [realpathSync(repoDir), realpathSync(implementationDir)]; sources.forEach(assertSafeInputTree);
  const root = mkdtempSync(join(tmpdir(), "arbitra-handoff-")); const repository = join(root, "repository"); const implementation = join(root, "implementation");
  try { cpSync(sources[0]!, repository, { recursive: true }); cpSync(sources[1]!, implementation, { recursive: true }); if (existsSync(join(root, ".runs"))) throw new Error("FRESH_EXECUTOR_RUN_CONTEXT_LEAK"); return operation({ root, repository, implementation }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function assertSafeInputTree(root: string): void { for (const entry of walk(root)) { const relativePath = relative(root, entry).replaceAll("\\", "/"); if (lstatSync(entry).isSymbolicLink()) throw new Error(`FRESH_EXECUTOR_SYMLINK_FORBIDDEN:${relativePath}`); if (relativePath === ".runs" || relativePath.startsWith(".runs/") || /(?:^|\/)journal(?:\.|\/|$)/iu.test(relativePath)) throw new Error(`FRESH_EXECUTOR_RUN_CONTEXT_FORBIDDEN:${relativePath}`); } }
function walk(root: string): string[] { const result: string[] = []; for (const entry of readdirSync(root, { withFileTypes: true })) { const path = join(root, entry.name); result.push(path); if (entry.isDirectory()) result.push(...walk(path)); } return result; }
function assertRequiredHandoff(implementation: string): void { for (const path of ["manifest.json", "AGENTS.md", "tasks/TASK-001/task.md", "validation/final-validation.md", "progress.schema.json"]) if (!existsSync(join(implementation, path))) throw new Error(`HANDOFF_REQUIRED_SECTION_MISSING:${path}`); }
function contractHashes(implementation: string): Record<string, string> { const result: Record<string, string> = {}; for (const path of walk(implementation).filter((entry) => lstatSync(entry).isFile())) { const rel = relative(implementation, path).replaceAll("\\", "/"); if (rel === "progress.jsonl" || rel.startsWith("execution/")) continue; result[rel] = createHash("sha256").update(readFileSync(path)).digest("hex"); } return result; }
function runTaskVerification(repository: string, implementation: string): { status: number; output: string } { const manifest = JSON.parse(readFileSync(join(implementation, "manifest.json"), "utf8")) as { tasks: readonly { id: string; verification: { commands: readonly { command: string; executionPolicy: string; expectedExitCode: number }[] } }[] }; const command = manifest.tasks.find(({ id }) => id === "TASK-001")?.verification.commands[0]; if (command?.command !== "npm test" || command.executionPolicy !== "derived_repository_script") throw new Error("HANDOFF_VERIFICATION_POLICY_INVALID"); const executable = process.platform === "win32" ? "npm.cmd" : "npm"; const result = spawnSync(executable, ["test"], { cwd: repository, encoding: "utf8", timeout: 60_000, windowsHide: true, shell: process.platform === "win32" }); return { status: result.status ?? 2, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}` }; }
function parseCommand(command: string): { executable: string; arguments: string[] } | null { const trimmed = command.trim(); if (trimmed === "" || /[;&|<>`\r\n]|\$\(/u.test(trimmed)) return null; const tokens = trimmed.match(/"[^"]*"|'[^']*'|[^\s]+/gu)?.map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2")) ?? []; const [executable, ...arguments_] = tokens; return executable === undefined ? null : { executable, arguments: arguments_ }; }
function releaseEnvironment(): NodeJS.ProcessEnv { const allowed = new Set(["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]); return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key))); }
function fileFact(content: string) { const lines = content.split(/(?<=\n)/u); let offset = 0; const starts = lines.map((line) => { const start = offset; offset += Buffer.byteLength(line); return start; }); return { lineCount: lines.length, lineStartBytes: starts, byteLength: Buffer.byteLength(content) }; }
function auditors() { return [{ auditorId: "auditor-a", independenceGroup: "group-a" }, { auditorId: "auditor-b", independenceGroup: "group-b" }] as const; }
function identityRng() { return { forActivity() { return this; }, shuffle<T>(items: T[]): T[] { return items; } }; }
async function loadModule(packageName: "core" | "providers" | "workflow", modulePath: string): Promise<Record<string, unknown>> { const selfCompiled = import.meta.url.replaceAll("\\", "/").includes("/dist/"); const targetCompiled = selfCompiled || process.env.ARBITRA_HANDOFF_USE_DIST === "1"; const relativePath = selfCompiled ? `../../../${packageName}/dist/src/${modulePath}.js` : targetCompiled ? `../../${packageName}/dist/src/${modulePath}.js` : `../../${packageName}/src/${modulePath}.ts`; return await import(new URL(relativePath, import.meta.url).href) as Record<string, unknown>; }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`; return JSON.stringify(value); }
