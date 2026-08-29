import { createHash } from "node:crypto";
import { deterministicCluster } from "@arbitra/workflow/clustering/deterministic.js";
import type { ValidatedClusterInput } from "@arbitra/workflow/clustering/types.js";
import { computeConsensus, DEFAULT_CONSENSUS_POLICY, type ConsensusBoard, type ConsensusCandidate, type ConsensusPolicy, type ConsensusState, type ConsensusVote } from "@arbitra/workflow/consensus/engine.js";
import { canonicaliseIssues, type CanonicalIssueSet } from "@arbitra/workflow/nodes/canonical-issues.js";
import { validateFindings, type AuditorFootprint, type ValidationSnapshot } from "@arbitra/workflow/nodes/validate-findings.js";
import { verifyItems, type VerificationOperationSink, type VerificationResult } from "@arbitra/workflow/nodes/verification/engine.js";
import type { VerificationAttempt, VerificationItem, VerificationTools } from "@arbitra/workflow/nodes/verification/ladder.js";
import { plannerNode, type PlannerInput } from "@arbitra/workflow/nodes/planner/node.js";
import { criticNode, type StructuredCritique } from "@arbitra/workflow/nodes/critic/node.js";
import type { CriticProfile } from "@arbitra/workflow/nodes/critic/selection.js";
import { AUDITOR_KIND, runAuditor, type AuditFinding, type AuditorProfile } from "./auditors.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";

const PROTOCOL_VERSION = "1.0.0";
const protocolHash = (id: string): string => createHash("sha256").update(`${id}@${PROTOCOL_VERSION}`).digest("hex");

/**
 * The premise this system exists to measure is not exercised by a scripted-auditor run,
 * so the plan carries that statement rather than a status the run did not earn.
 */
export const SCRIPTED_PREMISE_REPORT = Object.freeze({
  status: "unavailable" as const,
  interpretation: "smoke_test_only_not_proof" as const,
  limitations: Object.freeze([
    "auditors_are_deterministic_detectors_not_models",
    "independent_discovery_premise_unmeasured",
  ]),
});

export interface AuditContext {
  readonly snapshot: RepositorySnapshot;
  readonly store: RunStore;
  readonly auditors: readonly AuditorProfile[];
  readonly policy: ConsensusPolicy;
  readonly maximumRounds: number;
  readonly criticEnabled: boolean;
}

export interface PreflightResult { readonly fileCount: number; readonly lineCount: number; readonly auditorIds: readonly string[] }

export async function preflight(context: AuditContext): Promise<PreflightResult> {
  const lineCount = context.snapshot.files.reduce((total, file) => total + file.lines.length, 0);
  const result: PreflightResult = Object.freeze({
    fileCount: context.snapshot.files.length,
    lineCount,
    auditorIds: Object.freeze(context.auditors.map(({ auditorId }) => auditorId)),
  });
  await context.store.publish("preflight", { ...result, auditorKind: AUDITOR_KIND, root: context.snapshot.root });
  return result;
}

/** Round-0 discovery for one auditor. No auditor sees another's findings (spec section 3.1). */
export function discover(context: AuditContext, auditorId: string): readonly AuditFinding[] {
  const profile = context.auditors.find((item) => item.auditorId === auditorId);
  if (profile === undefined) throw new Error(`UNKNOWN_AUDITOR:${auditorId}`);
  return runAuditor(profile, context.snapshot);
}

export interface ConvergenceResult {
  readonly board: ConsensusBoard;
  readonly consensus: ConsensusState;
  readonly rejectedCount: number;
  readonly candidateFindings: Readonly<Record<string, readonly AuditFinding[]>>;
}

/**
 * Validation, clustering and peer review over the union of every auditor's findings.
 *
 * Peer review is deterministic here: an auditor whose rule set covers a candidate's rule
 * re-examines it and votes on what it finds, while an auditor without that rule abstains
 * and is recorded as a missing reviewer rather than as a silent accept.
 */
export async function converge(context: AuditContext, byAuditor: Readonly<Record<string, readonly AuditFinding[]>>): Promise<ConvergenceResult> {
  const snapshot: ValidationSnapshot = Object.freeze({
    files: Object.fromEntries(context.snapshot.files.map((file) => [file.path, Object.freeze({ lineCount: file.lines.length, lineStartBytes: file.lineStartBytes, byteLength: file.byteLength })])),
  });
  // Each auditor read every scanned file, so its exposure footprint is those files whole.
  const footprints: Record<string, AuditorFootprint> = Object.fromEntries(context.auditors.map(({ auditorId }) => [auditorId, Object.freeze({
    nodeId: auditorId,
    ranges: Object.freeze(context.snapshot.files.map((file) => Object.freeze({ path: file.path, start: 0, end: file.byteLength }))),
  })]));

  const submissions = Object.entries(byAuditor).flatMap(([auditorId, findings]) => findings.map((finding) => ({ auditorId, finding, repairCount: 0 as const })));
  const findingById = new Map(submissions.map(({ finding }) => [finding.sourceFindingId, finding]));
  let rejectionCount = 0;
  const validation = await validateFindings(submissions, snapshot, footprints, {
    rejectionStore: { persistRejection: async (): Promise<string> => { rejectionCount += 1; return `rejection-${rejectionCount}`; } },
  });

  const clusterInputs: ValidatedClusterInput[] = validation.accepted.flatMap(({ auditorId, finding }) => {
    const full = findingById.get(finding.sourceFindingId);
    return full === undefined ? [] : [{ validation: "accepted" as const, auditorId, finding: full }];
  });
  const clustered = deterministicCluster(clusterInputs);

  const candidates: Record<string, ConsensusCandidate> = {};
  const candidateFindings: Record<string, readonly AuditFinding[]> = {};
  for (const cluster of clustered.clusters) {
    const members = cluster.sourceFindingIds.flatMap((id) => { const value = findingById.get(id); return value === undefined ? [] : [value]; });
    const lead = members[0];
    if (lead === undefined) continue;
    const rule = ruleOf(lead.sourceFindingId);
    const votes: ConsensusVote[] = [];
    for (const auditor of context.auditors) {
      if (!auditor.ruleIds.includes(rule)) continue;
      const own = members.find(({ sourceFindingId }) => sourceFindingId.startsWith(`${auditor.auditorId}/`));
      votes.push(Object.freeze(own === undefined
        ? { authorId: auditor.auditorId, disposition: "reject" as const, citedEvidenceIds: Object.freeze([]), reason: "Re-examined the cited lines and the pattern does not hold there." }
        : { authorId: auditor.auditorId, disposition: "accept" as const, citedEvidenceIds: Object.freeze(own.evidence.map(({ id }) => id)), reason: "Independently found the same defect at the same location." }));
    }
    candidates[cluster.clusterId] = Object.freeze({
      candidateId: cluster.clusterId,
      claim: Object.freeze({ title: lead.title, description: lead.problem }),
      sourceFindingIds: Object.freeze([...cluster.sourceFindingIds].sort()),
      severity: lead.severity,
      blocker: lead.productionBlocker,
      status: "open",
      votes: Object.freeze(votes),
      evidence: Object.freeze(members.flatMap(({ evidence }) => [...evidence])),
      counterEvidence: Object.freeze([]),
      firstSeenRound: 0,
      lastChangedRound: 0,
      category: lead.category,
    });
    candidateFindings[cluster.clusterId] = Object.freeze(members);
  }

  const board: ConsensusBoard = Object.freeze({ candidates: Object.freeze(candidates) });
  const consensus = computeConsensus(board, context.policy, {
    auditors: context.auditors.map(({ auditorId, independenceGroup }) => ({ auditorId, independenceGroup })),
    round: 1,
    maximumRounds: context.maximumRounds,
  });

  await context.store.publish("source-findings", validation.accepted.flatMap(({ finding, auditorId }) => {
    const full = findingById.get(finding.sourceFindingId);
    return full === undefined ? [] : [{ sourceFindingId: full.sourceFindingId, category: full.category, title: full.title, severity: full.severity, status: "open", productionBlocker: full.productionBlocker, locations: full.locations, evidence: full.evidence, auditorId }];
  }));
  await context.store.publish("issue-operations", Object.values(candidates).flatMap((candidate) => candidate.votes.map((vote, index) => ({
    operationId: `${candidate.candidateId}-vote-${index}`,
    candidateId: candidate.candidateId,
    actorId: vote.authorId,
    round: 1,
    kind: "vote",
    payload: { disposition: vote.disposition, citedEvidenceIds: vote.citedEvidenceIds, reason: vote.reason },
  }))));

  const result: ConvergenceResult = Object.freeze({ board, consensus, rejectedCount: rejectionCount, candidateFindings: Object.freeze(candidateFindings) });
  await context.store.publish("consensus-state", result);
  return result;
}

/** Read a stage's published output back. Stages communicate through the artifact store. */
export async function readStage<T>(store: RunStore, kind: string): Promise<T> {
  const descriptor = (await store.listArtifacts()).find((item) => item.kind === kind);
  if (descriptor === undefined) throw new Error(`STAGE_ARTIFACT_ABSENT:${kind}`);
  return JSON.parse((await store.readArtifact(descriptor.artifactId)).content) as T;
}

/**
 * The deterministic verification ladder over every escalated candidate.
 *
 * `readCitedLines` is a real check: it re-reads the cited line from the snapshot and
 * confirms or rejects the claim against what is actually there. The remaining rungs return
 * `inconclusive` because this run has no symbol index, route table or dependency graph.
 * That is an honest "did not attempt", not a silent pass.
 */
export async function verify(context: AuditContext, convergence: ConvergenceResult): Promise<readonly VerificationResult[]> {
  const items: VerificationItem[] = convergence.consensus.candidates
    .filter(({ escalateToVerification }) => escalateToVerification)
    .flatMap(({ candidateId }) => {
      const candidate = convergence.board.candidates[candidateId];
      if (candidate === undefined) return [];
      const members = convergence.candidateFindings[candidateId] ?? [];
      return [Object.freeze({
        candidateId,
        severity: candidate.severity,
        claim: candidate.claim.title,
        question: `Do the cited lines still exhibit: ${candidate.claim.title}?`,
        citedEvidenceIds: Object.freeze(members.flatMap(({ evidence }) => evidence.map(({ id }) => id))),
        citedContext: Object.freeze(members.flatMap(({ evidence }) => evidence.map(({ id, text }) => Object.freeze({ evidenceId: id, text })))),
        symbols: Object.freeze([]),
        routes: Object.freeze([]),
        dependencies: Object.freeze([]),
      })];
    });

  const sink: VerificationOperationSink = { append: async (): Promise<void> => undefined };
  const outcome = await verifyItems(items, deterministicTools(context, convergence), { maximumItems: 50, allowModelCall: false, round: 1 }, { sink });
  await context.store.publish("verification-results", outcome.results.map(({ candidateId, outcome: result, method }) => ({ candidateId, result, method })));
  return outcome.results;
}

function deterministicTools(context: AuditContext, convergence: ConvergenceResult): VerificationTools {
  const inconclusive = (method: VerificationAttempt["method"], candidateId: string): VerificationAttempt => Object.freeze({
    method,
    verdict: "inconclusive" as const,
    evidenceIds: Object.freeze([]),
    artifactRefs: Object.freeze([]),
    toolCallIds: Object.freeze([]),
    activityId: `${candidateId}:${method}`,
    confidence: null,
  });
  const byPath = new Map(context.snapshot.files.map((file) => [file.path, file]));
  return {
    readCitedLines: async (item): Promise<VerificationAttempt> => {
      const members = convergence.candidateFindings[item.candidateId] ?? [];
      const checks = members.flatMap((finding) => finding.locations.map((location) => {
        const line = byPath.get(location.path)?.lines[location.startLine - 1];
        const evidence = finding.evidence.find(({ locationIds }) => locationIds.includes(location.id));
        return line !== undefined && evidence !== undefined && line.trim().slice(0, 200) === evidence.text;
      }));
      const confirmed = checks.length > 0 && checks.every(Boolean);
      return Object.freeze({
        method: "cited_lines" as const,
        verdict: confirmed ? "confirmed" as const : checks.length === 0 ? "inconclusive" as const : "rejected" as const,
        evidenceIds: Object.freeze([...item.citedEvidenceIds]),
        artifactRefs: Object.freeze([]),
        toolCallIds: Object.freeze([`read:${item.candidateId}`]),
        activityId: `${item.candidateId}:cited_lines`,
        confidence: confirmed ? 1 : 0,
      });
    },
    searchSymbolOrCallPath: async (item) => inconclusive("symbol_or_call_path", item.candidateId),
    inspectRouteConfigMiddleware: async (item) => inconclusive("route_config_middleware", item.candidateId),
    inspectDependencyOrImportPath: async (item) => inconclusive("dependency_or_import_path", item.candidateId),
    runAllowlistedSafeTest: async (item) => inconclusive("allowlisted_safe_test", item.candidateId),
    boundedDeterministicCheck: async (item) => inconclusive("bounded_deterministic_check", item.candidateId),
  };
}

export async function canonicalise(context: AuditContext, convergence: ConvergenceResult, verification: readonly VerificationResult[]): Promise<CanonicalIssueSet> {
  const issues = canonicaliseIssues(
    {
      candidates: Object.fromEntries(Object.entries(convergence.board.candidates).map(([id, candidate]) => [id, {
        candidateId: candidate.candidateId,
        claim: candidate.claim,
        sourceFindingIds: candidate.sourceFindingIds,
        severity: candidate.severity,
        blocker: candidate.blocker,
        counterEvidence: [],
      }])),
      consensus: { auditorCount: convergence.consensus.auditorCount, candidates: convergence.consensus.candidates },
    },
    verification.map(({ candidateId, outcome }) => ({ candidateId, outcome })),
    {
      // Scripted detectors do not run the security protocol, so security coverage is
      // reported degraded rather than left to read as complete.
      securityCoverage: { degraded: true, reason: "scripted_detectors_do_not_cover_the_security_protocol" },
      suppressionCandidates: [],
      unexaminedSurfaces: [],
      limitations: [`auditor_kind:${AUDITOR_KIND}`, `findings_rejected_on_validation:${convergence.rejectedCount}`],
    },
  );
  await context.store.publish("canonical-issues", issues);
  return issues;
}

export async function plan(context: AuditContext, issues: CanonicalIssueSet): Promise<Plan> {
  const accepted = issues.issues.filter(({ disposition }) => disposition === "accepted");
  const input: PlannerInput = Object.freeze({
    projectContext: { root: context.snapshot.root, fileCount: context.snapshot.files.length },
    canonicalIssues: Object.freeze(accepted.map(({ candidateId, disposition, claim, sourceFindingIds }) => Object.freeze({ candidateId, disposition, claim, sourceFindingIds }))),
    repositoryContext: Object.freeze([]),
    constraints: Object.freeze(["audit_mode_is_read_only"]),
    workflowGoal: "Resolve every accepted canonical issue without changing behaviour.",
    premiseReport: SCRIPTED_PREMISE_REPORT,
  });

  const node = plannerNode<Plan>({
    protocolVersion: PROTOCOL_VERSION,
    protocolHash: protocolHash("planner"),
    runtime: { plan: async (request) => buildPlan(request.input) },
    schema: { parse: (value) => value as Plan },
  });
  const { plan: produced } = await node.run(input);
  await context.store.publish("plan-ir", produced);
  return produced;
}

export async function critique(context: AuditContext, produced: Plan, issues: CanonicalIssueSet): Promise<StructuredCritique | null> {
  const accepted = issues.issues.filter(({ disposition }) => disposition === "accepted");
  if (!context.criticEnabled) {
    await context.store.publish("critic-feedback", { summary: "critic disabled by configuration", items: [] });
    return null;
  }
  const critic = criticNode({
    protocolVersion: PROTOCOL_VERSION,
    protocolHash: protocolHash("plan-critic"),
    runtime: { critique: async () => buildCritique(produced) },
    schema: { parse: (value) => value as StructuredCritique },
  });
  const pool: readonly CriticProfile[] = Object.freeze([
    Object.freeze({ id: "critic-1", capability: "balanced" as const, independenceGroup: "group-critic", available: true }),
  ]);
  const outcome = await critic.run(
    { plan: produced, validationContract: produced.validationContract, canonicalIssues: accepted.map(({ candidateId }) => ({ candidateId })), necessaryContext: [] },
    {
      requirement: { deepMode: true, hasCriticalIssue: accepted.some(({ severity }) => severity === "critical") },
      pool,
      planner: { id: "planner-1", capability: "balanced", independenceGroup: "group-planner" },
    },
  );
  const produced_critique = outcome.status === "completed" ? outcome.critique : null;
  await context.store.publish("critic-feedback", produced_critique ?? { summary: `critic ${outcome.status}`, items: [] });
  return produced_critique;
}

interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly addresses: { readonly issues: readonly string[]; readonly validation: readonly string[]; readonly requirements: readonly string[] };
  readonly context: readonly string[];
  readonly routing: { readonly capability: string; readonly effort: string; readonly reason: readonly string[] };
  readonly dependencies: { readonly dependsOn: readonly string[]; readonly blocks: readonly string[]; readonly conflictsWith: readonly string[] };
}

export interface Plan {
  readonly id: string;
  readonly title: string;
  readonly mode: "audit";
  readonly acceptedIssueIds: readonly string[];
  readonly validationContract: { readonly validation: readonly { readonly id: string; readonly assertion: string; readonly evidence: readonly string[] }[] };
  readonly tasks: readonly PlanTask[];
  readonly taskGraph: readonly { readonly from: string; readonly to: string }[];
  readonly traceability: {
    readonly issueToValidation: readonly { readonly issueId: string; readonly validationIds: readonly string[] }[];
    readonly requirementLinks: { readonly schemaVersion: number; readonly links: readonly { readonly requirementId: string; readonly validationIds: readonly string[]; readonly taskIds: readonly string[] }[] };
  };
  readonly routingRecommendations: readonly { readonly taskId: string; readonly capability: string; readonly effort: string; readonly reason: readonly string[] }[];
  readonly unresolvedQuestions: readonly { readonly id: string; readonly question: string; readonly blocking: boolean; readonly blastRadius: "low" | "medium" | "high" }[];
  readonly premiseReport: typeof SCRIPTED_PREMISE_REPORT;
}

/** One validation assertion and one task per accepted issue, so traceability closes. */
function buildPlan(input: PlannerInput): Plan {
  const issues = input.canonicalIssues;
  const validation = issues.map((issue, index) => Object.freeze({
    id: `V-${index + 1}`,
    assertion: `${issue.claim.title} no longer holds at any cited location.`,
    evidence: Object.freeze([...issue.sourceFindingIds]),
  }));
  const tasks: readonly PlanTask[] = issues.map((issue, index) => Object.freeze({
    id: `T-${index + 1}`,
    title: `Resolve: ${issue.claim.title}`,
    addresses: Object.freeze({ issues: Object.freeze([issue.candidateId]), validation: Object.freeze([`V-${index + 1}`]), requirements: Object.freeze([]) }),
    context: Object.freeze([...issue.sourceFindingIds]),
    routing: Object.freeze({ capability: "balanced", effort: "medium", reason: Object.freeze(["single_issue_scope"]) }),
    dependencies: Object.freeze({ dependsOn: Object.freeze([]), blocks: Object.freeze([]), conflictsWith: Object.freeze([]) }),
  }));
  return Object.freeze({
    id: "plan-1",
    title: "Audit remediation plan",
    mode: "audit" as const,
    acceptedIssueIds: Object.freeze(issues.map(({ candidateId }) => candidateId).sort()),
    validationContract: Object.freeze({ validation: Object.freeze(validation) }),
    tasks: Object.freeze(tasks),
    taskGraph: Object.freeze([]),
    traceability: Object.freeze({
      issueToValidation: Object.freeze(issues.map((issue, index) => Object.freeze({ issueId: issue.candidateId, validationIds: Object.freeze([`V-${index + 1}`]) }))),
      requirementLinks: Object.freeze({ schemaVersion: 1, links: Object.freeze([]) }),
    }),
    routingRecommendations: Object.freeze(tasks.map(({ id }) => Object.freeze({ taskId: id, capability: "balanced", effort: "medium", reason: Object.freeze(["single_issue_scope"]) }))),
    unresolvedQuestions: Object.freeze([]),
    premiseReport: SCRIPTED_PREMISE_REPORT,
  });
}

/** Deterministic critique: structural properties of the plan, checked rather than opined. */
function buildCritique(plan: Plan): StructuredCritique {
  const unvalidated = plan.tasks.filter(({ addresses }) => addresses.validation.length === 0);
  const items = [
    ...(plan.taskGraph.length === 0 && plan.tasks.length > 1
      ? [Object.freeze({ id: "C-1", category: "wrong_dependencies" as const, blocking: false, summary: "The plan records no dependencies between tasks, so nothing states which remediations may safely run in parallel.", taskIds: Object.freeze(plan.tasks.map(({ id }) => id)), issueIds: Object.freeze([]) })]
      : []),
    ...(unvalidated.length > 0
      ? [Object.freeze({ id: "C-2", category: "weak_acceptance_criteria" as const, blocking: true, summary: "A task carries no validation assertion, so its completion is unfalsifiable.", taskIds: Object.freeze(unvalidated.map(({ id }) => id)), issueIds: Object.freeze([]) })]
      : []),
  ];
  return Object.freeze({ items: Object.freeze(items), summary: `${items.length} structural observation(s) over ${plan.tasks.length} task(s).` });
}

function ruleOf(sourceFindingId: string): string { return sourceFindingId.split("/")[1] ?? ""; }

export { DEFAULT_CONSENSUS_POLICY };
