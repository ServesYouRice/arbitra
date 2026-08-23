import { createHash } from "node:crypto";

export type ReplayConsensusPolicy = "full" | "risk_weighted" | "minimal";

export interface ReplayOverrides {
  readonly consensusPolicy: ReplayConsensusPolicy;
  readonly maximumRounds: 1 | 2 | 3;
  readonly criticEnabled: boolean;
}

export interface RoundZeroFindingArtifact {
  readonly artifactRef: string;
  readonly findings: readonly unknown[];
}

export interface ReplaySourceRun {
  readonly runId: string;
  readonly roundZero: readonly RoundZeroFindingArtifact[];
  readonly result: ComparableRun;
}

export interface ReplayRunResult {
  readonly runId: string;
  readonly sourceRunId: string;
  readonly reusedRoundZeroArtifactRefs: readonly string[];
  readonly overrides: ReplayOverrides;
  readonly clustering: unknown;
  readonly consensus: unknown;
  readonly verification: unknown;
}

export interface ReplayRepository {
  loadRun(runId: string): Promise<ReplaySourceRun>;
  saveReplay(result: ReplayRunResult): Promise<void>;
}

export interface ReplayPipeline {
  cluster(findings: readonly unknown[]): Promise<unknown>;
  reachConsensus(clustering: unknown, overrides: ReplayOverrides): Promise<unknown>;
  verify(consensus: unknown, overrides: ReplayOverrides): Promise<unknown>;
}

export interface ComparableIssue {
  readonly id: string;
  readonly status: string;
  readonly severity: string;
  readonly verification: string | null;
}

export interface ComparableRun {
  readonly runId: string;
  readonly issues: readonly ComparableIssue[];
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface RunDiff {
  readonly runA: string;
  readonly runB: string;
  readonly addedIssueIds: readonly string[];
  readonly removedIssueIds: readonly string[];
  readonly changedIssues: readonly {
    readonly id: string;
    readonly before: Omit<ComparableIssue, "id">;
    readonly after: Omit<ComparableIssue, "id">;
  }[];
  readonly metricDeltas: Readonly<Record<string, number | null>>;
}

export interface DiffFastFinding {
  readonly id: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "informational";
  readonly source: "primary" | "sampled_second_auditor";
}

export interface DiffFastGateResult {
  readonly findings: readonly DiffFastFinding[];
  readonly materialFindingIds: readonly string[];
  readonly gatePassed: boolean;
}

export interface ExportEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: string;
  readonly artifactRef: string;
}

export interface ExportableRun {
  readonly runId: string;
  readonly issues: readonly { readonly id: string; readonly title: string; readonly evidence: readonly ExportEvidence[] }[];
}

export interface Redactor {
  redact(text: string): { readonly text: string; readonly redactionCount: number };
}

export async function replay(
  runId: string,
  overrides: ReplayOverrides,
  dependencies: {
    readonly repository: ReplayRepository;
    readonly pipeline: ReplayPipeline;
    readonly createRunId: (sourceRunId: string, overrides: ReplayOverrides) => string;
  },
): Promise<ReplayRunResult> {
  validateRunId(runId);
  validateOverrides(overrides);
  const source = await dependencies.repository.loadRun(runId);
  if (source.runId !== runId || source.roundZero.length === 0) throw new Error("REPLAY_SOURCE_FINDINGS_UNAVAILABLE");
  const before = fingerprint(source);
  const artifactRefs = source.roundZero.map(({ artifactRef }) => {
    if (artifactRef.trim() === "") throw new Error("REPLAY_SOURCE_ARTIFACT_REF_INVALID");
    return artifactRef;
  });
  const findings = source.roundZero.flatMap(({ findings: values }) => values);
  const clustering = await dependencies.pipeline.cluster(Object.freeze(findings));
  const consensus = await dependencies.pipeline.reachConsensus(clustering, overrides);
  const verification = await dependencies.pipeline.verify(consensus, overrides);
  const replayRunId = dependencies.createRunId(runId, overrides);
  validateRunId(replayRunId);
  if (replayRunId === runId) throw new Error("REPLAY_MUST_CREATE_NEW_RUN");
  const result = Object.freeze({
    runId: replayRunId,
    sourceRunId: runId,
    reusedRoundZeroArtifactRefs: Object.freeze([...artifactRefs]),
    overrides: Object.freeze({ ...overrides }),
    clustering,
    consensus,
    verification,
  });
  const after = await dependencies.repository.loadRun(runId);
  if (fingerprint(after) !== before) throw new Error("REPLAY_SOURCE_RUN_MUTATED");
  await dependencies.repository.saveReplay(result);
  return result;
}

export function diffRuns(a: ComparableRun, b: ComparableRun): RunDiff {
  validateRunId(a.runId);
  validateRunId(b.runId);
  const left = issueMap(a.issues);
  const right = issueMap(b.issues);
  const addedIssueIds = [...right.keys()].filter((id) => !left.has(id)).sort();
  const removedIssueIds = [...left.keys()].filter((id) => !right.has(id)).sort();
  const changedIssues = [...left.keys()].filter((id) => right.has(id) && fingerprint(left.get(id)) !== fingerprint(right.get(id)))
    .sort()
    .map((id) => {
      const before = left.get(id)!;
      const after = right.get(id)!;
      return Object.freeze({ id, before: withoutId(before), after: withoutId(after) });
    });
  const metricKeys = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].sort();
  const metricDeltas = Object.fromEntries(metricKeys.map((key) => {
    const before = a.metrics[key];
    const after = b.metrics[key];
    return [key, typeof before === "number" && typeof after === "number" ? round(after - before) : null];
  }));
  return Object.freeze({ runA: a.runId, runB: b.runId, addedIssueIds: Object.freeze(addedIssueIds), removedIssueIds: Object.freeze(removedIssueIds), changedIssues: Object.freeze(changedIssues), metricDeltas: Object.freeze(metricDeltas) });
}

export function sampleSecondAuditor(repo: string, base: string, head: string, protocol: string, denominator = 10): boolean {
  if (![repo, base, head, protocol].every((value) => value.trim() !== "")) throw new Error("INVALID_SAMPLING_IDENTITY");
  if (!Number.isSafeInteger(denominator) || denominator < 1) throw new Error("INVALID_SAMPLING_DENOMINATOR");
  const digest = createHash("sha256").update([repo, base, head, protocol].map(frame).join("")).digest();
  return digest.readBigUInt64BE(0) % BigInt(denominator) === 0n;
}

export function applySampledFindings(primary: readonly DiffFastFinding[], sampled: readonly DiffFastFinding[]): DiffFastGateResult {
  if (sampled.some(({ source }) => source !== "sampled_second_auditor")) throw new Error("INVALID_SAMPLED_FINDING_SOURCE");
  const byId = new Map<string, DiffFastFinding>();
  for (const finding of [...primary, ...sampled]) {
    if (finding.id.trim() === "") throw new Error("INVALID_DIFF_FAST_FINDING_ID");
    const existing = byId.get(finding.id);
    if (existing === undefined || severityRank(finding.severity) > severityRank(existing.severity)) byId.set(finding.id, finding);
  }
  const findings = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  const materialFindingIds = findings.filter(({ severity }) => severity === "critical" || severity === "high").map(({ id }) => id);
  return Object.freeze({ findings: Object.freeze(findings), materialFindingIds: Object.freeze(materialFindingIds), gatePassed: materialFindingIds.length === 0 });
}

export function createRedactedExport(run: ExportableRun, redactor: Redactor): Readonly<Record<string, unknown>> {
  validateRunId(run.runId);
  let redactionCount = 0;
  const issues = run.issues.map((issue) => Object.freeze({
    id: issue.id,
    title: redact(issue.title),
    evidence: Object.freeze(issue.evidence.map((evidence) => Object.freeze({
      path: evidence.path,
      lineRange: Object.freeze({ start: evidence.startLine, end: evidence.endLine }),
      quote: redact(evidence.quote),
      artifactRef: evidence.artifactRef,
    }))),
  }));
  return Object.freeze({ schemaVersion: 1, runId: run.runId, redactionCount, issues: Object.freeze(issues) });

  function redact(text: string): string {
    const result = redactor.redact(text);
    if (!Number.isSafeInteger(result.redactionCount) || result.redactionCount < 0) throw new Error("INVALID_EXPORT_REDACTION_RESULT");
    redactionCount += result.redactionCount;
    return result.text;
  }
}

function issueMap(issues: readonly ComparableIssue[]): Map<string, ComparableIssue> {
  const result = new Map<string, ComparableIssue>();
  for (const issue of issues) {
    if (issue.id.trim() === "" || result.has(issue.id)) throw new Error("INVALID_COMPARABLE_ISSUES");
    result.set(issue.id, issue);
  }
  return result;
}
function withoutId(issue: ComparableIssue): Omit<ComparableIssue, "id"> { return Object.freeze({ status: issue.status, severity: issue.severity, verification: issue.verification }); }
function validateRunId(runId: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(runId)) throw new Error("INVALID_REPLAY_RUN_ID"); }
function validateOverrides(value: ReplayOverrides): void { if (!["full", "risk_weighted", "minimal"].includes(value.consensusPolicy) || ![1, 2, 3].includes(value.maximumRounds) || typeof value.criticEnabled !== "boolean") throw new Error("INVALID_REPLAY_OVERRIDES"); }
function frame(value: string): string { return `${Buffer.byteLength(value)}:${value}`; }
function fingerprint(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function severityRank(value: DiffFastFinding["severity"]): number { return ({ informational: 0, low: 1, medium: 2, high: 3, critical: 4 } as const)[value]; }
