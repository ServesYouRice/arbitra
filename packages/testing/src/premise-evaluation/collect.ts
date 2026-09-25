import type { ModelActivityTraceRecord } from "@arbitra/schemas/model-trace.js";

/**
 * What the evaluation reads from one completed public Audit run. Everything comes from the
 * run's own published artifacts and durable model traces through the Orchestrator's public
 * read methods; nothing is inferred from logs.
 */
export interface RecordedFinding {
  readonly sourceFindingId: string;
  readonly auditorId: string;
  readonly category: string;
  readonly title: string;
  readonly severity: string;
  readonly problem: string;
  readonly recommendedFix: string;
  readonly locations: readonly { readonly path: string; readonly startLine: number; readonly endLine: number }[];
  readonly evidence: readonly { readonly text: string }[];
}

export interface RecordedAuditor {
  readonly auditorId: string;
  readonly modelId: string;
  readonly independenceGroup: string;
  readonly transport: string;
  /** Discovery findings that passed evidence grounding (the runtime's `findings-<auditor>`). */
  readonly findings: readonly RecordedFinding[];
  /** Findings the runtime rejected on evidence/location validation. */
  readonly rejectedFindings: readonly RecordedFinding[];
  /** Findings whose evidence quote was not found in the cited lines (ids only; the runtime keeps no copy). */
  readonly quoteRejectedCount: number;
  readonly repairedCount: number;
  readonly truncated: boolean;
  readonly usage: UsageSummary;
}

export interface RecordedIssue {
  readonly candidateId: string;
  readonly title: string;
  readonly description: string;
  readonly severity: string;
  readonly disposition: string;
  readonly verificationOutcome: string | null;
  readonly sourceFindingIds: readonly string[];
}

export interface UsageSummary {
  /** Provider attempts recorded as traces (every retry and repair turn counts). */
  readonly requests: number;
  readonly failedRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Attempts whose provider reported no usage; their tokens are unknown, not zero. */
  readonly unknownUsageRequests: number;
  readonly attemptDurationMs: number;
  readonly repairTurns: number;
}

export interface RunIdentity {
  readonly protocol: { readonly id: string; readonly version: string; readonly hash: string };
  readonly harness: { readonly id: string; readonly version: string; readonly policyHash: string };
  readonly models: readonly { readonly auditorId: string; readonly modelId: string; readonly modelProfileVersion: string; readonly transportId: string; readonly transportVersion: string }[];
}

export interface RecordedRun {
  readonly runId: string;
  readonly state: string;
  readonly snapshot: { readonly repositoryDigest: string; readonly gitHead: string | null };
  readonly identity: RunIdentity;
  readonly auditors: readonly RecordedAuditor[];
  readonly sourceFindings: readonly RecordedFinding[];
  readonly issues: readonly RecordedIssue[];
  readonly verification: readonly { readonly candidateId: string; readonly result: string; readonly method: string }[];
  readonly plan: { readonly acceptedIssueIds: readonly string[]; readonly addressedIssueIds: readonly string[]; readonly taskCount: number } | null;
  readonly critic: { readonly items: number; readonly blocking: number } | null;
  readonly usage: UsageSummary;
  readonly usageByNode: Readonly<Record<string, UsageSummary>>;
}

/** The subset of the public Orchestrator the collector reads. */
export interface RunReader {
  artifacts(runId: string): Promise<readonly { readonly artifactId: string; readonly kind: string }[]>;
  artifact(runId: string, artifactId: string): Promise<unknown>;
  modelTraces(runId: string): Promise<readonly ModelActivityTraceRecord[]>;
  status(runId: string): Promise<{ readonly state: string }>;
}

interface ModelProfileLike { readonly modelId: string; readonly independenceGroup: string; readonly transport: string }

export async function collectRun(reader: RunReader, runId: string, profiles: Readonly<Record<string, ModelProfileLike>>, auditorIds: readonly string[]): Promise<RecordedRun> {
  const descriptors = await reader.artifacts(runId);
  const read = async <T>(kind: string): Promise<T | null> => {
    const descriptor = descriptors.find((item) => item.kind === kind);
    if (descriptor === undefined) return null;
    const { content } = await reader.artifact(runId, descriptor.artifactId) as { readonly content: string };
    return JSON.parse(content) as T;
  };
  const traces = await reader.modelTraces(runId);
  const identitySnapshot = await read<{ readonly repositoryDigest: string; readonly gitHead: string | null }>("snapshot-identity");
  if (identitySnapshot === null) throw new Error(`P06_SNAPSHOT_IDENTITY_ABSENT:${runId}`);
  const auditors = await Promise.all(auditorIds.map(async (auditorId): Promise<RecordedAuditor> => {
    const profile = profiles[auditorId];
    if (profile === undefined) throw new Error(`P06_AUDITOR_PROFILE_ABSENT:${auditorId}`);
    const findings = await read<readonly RawFinding[]>(`findings-${auditorId}`);
    if (findings === null) throw new Error(`P06_DISCOVERY_ABSENT:${runId}:${auditorId}`);
    const validation = await read<{ readonly truncated: boolean; readonly quoteRejections?: readonly string[]; readonly summaries?: readonly { readonly repaired: number }[] }>(`discovery-validation-${auditorId}`);
    const rejectedKinds = descriptors.filter(({ kind }) => kind.startsWith(`discovery-rejection-${auditorId}-`)).map(({ kind }) => kind);
    const rejected = (await Promise.all(rejectedKinds.map(async (kind) => (await read<{ readonly finding: RawFinding }>(kind))?.finding))).filter((value): value is RawFinding => value !== undefined);
    return Object.freeze({ auditorId, modelId: profile.modelId, independenceGroup: profile.independenceGroup, transport: profile.transport,
      findings: Object.freeze(findings.map((finding) => recorded(finding, auditorId))), rejectedFindings: Object.freeze(rejected.map((finding) => recorded(finding, auditorId))),
      quoteRejectedCount: validation?.quoteRejections?.length ?? 0, repairedCount: (validation?.summaries ?? []).reduce((sum, { repaired }) => sum + repaired, 0), truncated: validation?.truncated ?? false,
      usage: summarise(traces.filter(({ nodeId }) => nodeId === auditorId)) });
  }));
  const sources = await read<readonly RawFinding[]>("source-findings") ?? [];
  const issueSet = await read<{ readonly issues: readonly { readonly candidateId: string; readonly claim: { readonly title: string; readonly description: string }; readonly severity: string; readonly disposition: string; readonly verificationOutcome: string | null; readonly sourceFindingIds: readonly string[] }[] }>("canonical-issues");
  const plan = await read<{ readonly acceptedIssueIds: readonly string[]; readonly tasks: readonly { readonly addresses: { readonly issues: readonly string[] } }[] }>("plan-ir");
  const critic = await read<{ readonly items: readonly { readonly blocking: boolean }[] }>("critic-feedback");
  const byNode: Record<string, UsageSummary> = {};
  for (const nodeId of [...new Set(traces.map(({ nodeId }) => nodeId))].sort()) byNode[nodeId] = summarise(traces.filter((trace) => trace.nodeId === nodeId));
  return Object.freeze({
    runId, state: (await reader.status(runId)).state,
    snapshot: Object.freeze({ repositoryDigest: identitySnapshot.repositoryDigest, gitHead: identitySnapshot.gitHead }),
    identity: identityOf(traces, auditorIds, runId),
    auditors: Object.freeze(auditors),
    sourceFindings: Object.freeze(sources.map((finding) => recorded(finding, attribution(finding.sourceFindingId, auditorIds)))),
    issues: Object.freeze((issueSet?.issues ?? []).map((issue) => Object.freeze({ candidateId: issue.candidateId, title: issue.claim.title, description: issue.claim.description, severity: issue.severity, disposition: issue.disposition, verificationOutcome: issue.verificationOutcome, sourceFindingIds: Object.freeze([...issue.sourceFindingIds]) }))),
    verification: Object.freeze(await read<readonly { readonly candidateId: string; readonly result: string; readonly method: string }[]>("verification-results") ?? []),
    plan: plan === null ? null : Object.freeze({ acceptedIssueIds: Object.freeze([...plan.acceptedIssueIds]), addressedIssueIds: Object.freeze([...new Set(plan.tasks.flatMap(({ addresses }) => addresses.issues))].sort()), taskCount: plan.tasks.length }),
    critic: critic === null ? null : Object.freeze({ items: critic.items.length, blocking: critic.items.filter(({ blocking }) => blocking).length }),
    usage: summarise(traces), usageByNode: Object.freeze(byNode),
  });
}

interface RawFinding { readonly sourceFindingId: string; readonly category?: string; readonly title?: string; readonly severity?: string; readonly problem?: string; readonly recommendedFix?: string; readonly locations?: readonly { readonly path: string; readonly startLine: number; readonly endLine: number }[]; readonly evidence?: readonly { readonly text: string }[] }

function recorded(finding: RawFinding, auditorId: string): RecordedFinding {
  return Object.freeze({ sourceFindingId: finding.sourceFindingId, auditorId, category: finding.category ?? "", title: finding.title ?? "", severity: finding.severity ?? "", problem: finding.problem ?? "", recommendedFix: finding.recommendedFix ?? "",
    locations: Object.freeze((finding.locations ?? []).map(({ path, startLine, endLine }) => Object.freeze({ path, startLine, endLine }))), evidence: Object.freeze((finding.evidence ?? []).map(({ text }) => Object.freeze({ text }))) });
}

/** Discovery findings are namespaced `<auditorId>/...`; anything else was added during peer review. */
export function attribution(sourceFindingId: string, auditorIds: readonly string[]): string {
  const prefix = sourceFindingId.split("/")[0] ?? "";
  return auditorIds.includes(prefix) ? prefix : "peer_review";
}

export function summarise(traces: readonly ModelActivityTraceRecord[]): UsageSummary {
  let inputTokens = 0; let outputTokens = 0; let unknown = 0; let duration = 0; let failed = 0; let repairs = 0;
  for (const trace of traces) {
    if (trace.tokenUsage?.inputTokens == null || trace.tokenUsage.outputTokens == null) unknown += 1;
    else { inputTokens += trace.tokenUsage.inputTokens; outputTokens += trace.tokenUsage.outputTokens; }
    duration += trace.durationMs;
    if (trace.outcome !== "success") failed += 1;
    if (trace.activityId.includes("/repair-")) repairs += 1;
  }
  return Object.freeze({ requests: traces.length, failedRequests: failed, inputTokens, outputTokens, unknownUsageRequests: unknown, attemptDurationMs: duration, repairTurns: repairs });
}

/** Identity comes from the recorded discovery traces, never from configuration. */
function identityOf(traces: readonly ModelActivityTraceRecord[], auditorIds: readonly string[], runId: string): RunIdentity {
  const discovery = traces.filter(({ nodeId, outcome }) => auditorIds.includes(nodeId) && outcome === "success");
  const first = discovery[0];
  if (first === undefined) throw new Error(`P06_DISCOVERY_TRACE_ABSENT:${runId}`);
  for (const trace of discovery) if (trace.protocolHash !== first.protocolHash || trace.harnessPolicyHash !== first.harnessPolicyHash) throw new Error(`P06_MIXED_DISCOVERY_IDENTITY:${runId}`);
  return Object.freeze({
    protocol: Object.freeze({ id: first.protocolId, version: first.protocolVersion, hash: first.protocolHash }),
    harness: Object.freeze({ id: first.harnessId, version: first.harnessVersion, policyHash: first.harnessPolicyHash }),
    models: Object.freeze(auditorIds.map((auditorId) => {
      const trace = discovery.find(({ nodeId }) => nodeId === auditorId);
      if (trace === undefined) throw new Error(`P06_DISCOVERY_TRACE_ABSENT:${runId}:${auditorId}`);
      return Object.freeze({ auditorId, modelId: trace.modelId, modelProfileVersion: trace.modelProfileVersion, transportId: trace.transportId, transportVersion: trace.transportVersion });
    })),
  });
}
