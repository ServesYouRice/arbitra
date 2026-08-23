import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONSENSUS_POLICY, type ConsensusBoard } from "../../src/consensus/engine.js";
import { criticNode } from "../../src/nodes/critic/index.js";
import { peerReviewRound, runPeerReview, type PeerIssueOperation, type ReviewRng } from "../../src/nodes/peer-review/round.js";
import { validateFindings, type FindingSubmission } from "../../src/nodes/validate-findings.js";
import { validateTraceability, type TraceablePlan } from "../../src/nodes/planner/traceability.js";

const root = new URL("../../../testing/fixtures/misbehaviour/", import.meta.url);
interface Fixture { id: string; invariant: string; mechanism: string; expected: string; skipped?: boolean; skipReason?: string; activatedIn?: string; script?: Record<string, unknown> }
function fixture(name: string): Fixture { return JSON.parse(readFileSync(new URL(name, root), "utf8")) as Fixture; }

describe("known multi-agent misbehaviour fixtures", () => {
  it("protects fixture completeness invariant: all eight named cases declare mechanism and invariant", () => {
    const fixtures = readdirSync(root).filter((name) => name.endsWith(".json")).map(fixture);
    expect(fixtures).toHaveLength(8);
    expect(fixtures.every(({ invariant, mechanism }) => invariant.length > 0 && mechanism.length > 0)).toBe(true);
  });

  it("protects location-validity invariant by rejecting a scripted fabricated location mechanically", async () => {
    const value = fixture("fabricated-location.json"); const auditor = await fakeAuditor([submission(402, 402)]);
    const result = await validateFindings([await auditor.audit({ activity: value.id })], snapshot(), footprints(), { rejectionStore: store });
    expect(result.rejected[0]?.reasons.map(({ code }) => code)).toContain(value.expected);
    expect(auditor.networkRequests).toBe(0);
  });

  it("protects exposure-containment invariant by rejecting a scripted out-of-footprint quote", async () => {
    const value = fixture("outside-exposure.json"); const auditor = await fakeAuditor([submission(2, 2)]);
    const result = await validateFindings([await auditor.audit({ activity: value.id })], snapshot(), { "auditor-a": { nodeId: "discover", ranges: [{ path: "src/auth.ts", start: 0, end: 5 }] } }, { rejectionStore: store });
    expect(result.rejected[0]?.reasons.map(({ code }) => code)).toContain(value.expected);
    expect(auditor.networkRequests).toBe(0);
  });

  it("protects evidence-use invariant by rejecting a peer decision that ignores counter-evidence", async () => {
    const value = fixture("ignored-counter-evidence.json"); const operation: PeerIssueOperation = { operationId: "op-1", candidateId: "C-1", authorId: "auditor-a", round: 1, type: "accept", citedEvidenceIds: [] }; const auditor = await fakeAuditor([Object.freeze([operation])]);
    await expect(peerReviewRound(board(), DEFAULT_CONSENSUS_POLICY, 1, { auditors: auditors(), rng, runtime: { review: (request) => auditor.audit(request) } })).rejects.toThrow(value.expected);
    expect(auditor.networkRequests).toBe(0);
  });

  it("protects anti-conformity invariant by flagging a vote flip with no new cited evidence", async () => {
    const value = fixture("conformity-flip.json");
    const operation: PeerIssueOperation = { operationId: "op-flip", candidateId: "C-1", authorId: "auditor-a", round: 2, type: "accept", citedEvidenceIds: ["E-1"] };
    const auditor = await fakeAuditor([Object.freeze([operation])]);
    const priorBoard = board(false, [{ authorId: "auditor-a", disposition: "reject", citedEvidenceIds: ["E-1"], reason: "Repository evidence contradicts the claim." }], 1);
    await expect(peerReviewRound(priorBoard, DEFAULT_CONSENSUS_POLICY, 2, { auditors: auditors(), rng, runtime: { review: (request) => auditor.audit(request) } })).rejects.toThrow(value.expected);
    expect(auditor.networkRequests).toBe(0);
    const justified = { ...operation, operationId: "op-justified-flip", citedEvidenceIds: ["E-1", "E-2"] };
    const justifiedAuditor = await fakeAuditor<readonly PeerIssueOperation[]>([[justified], []]);
    await expect(peerReviewRound(priorBoard, DEFAULT_CONSENSUS_POLICY, 2, { auditors: auditors(), rng, runtime: { review: (request) => justifiedAuditor.audit(request) } })).resolves.toMatchObject({ operations: [justified] });
  });

  it("protects the derived-envelope invariant by displaying but never granting planner scope outside authority", async () => {
    const value = fixture("scope-outside-envelope.json");
    const moduleUrl = new URL("../../../security/src/envelope.ts", import.meta.url).href;
    const { deriveEnvelope, intersectScope } = await import(moduleUrl) as EnvelopeFunctions;
    const envelope = deriveEnvelope(
      [{ id: "ISSUE-1", accepted: true, locations: [{ path: "src/auth/login.ts" }] }],
      [
        { id: "auth", files: ["src/auth/login.ts", "src/auth/session.ts"] },
        { id: "deployment", files: [".github/workflows/deploy.yml"] },
      ],
    );
    const result = intersectScope(["src/auth/login.ts", ".github/workflows/deploy.yml"], envelope);
    expect(result.granted).toEqual(["src/auth/login.ts"]);
    expect(result.displayedOnly).toEqual([".github/workflows/deploy.yml"]);
    expect(value.expected).toBe("displayed_only");
    expect(value.activatedIn).toBe("TASK-037");
  });

  it("protects plan traceability invariant by hard-failing a task with no validation assertion", () => {
    const value = fixture("task-without-validation.json");
    const plan: TraceablePlan = { mode: "audit", acceptedIssueIds: [], unresolvedQuestions: [], validationContract: { validation: [{ id: "VAL-001" }] }, tasks: [{ id: "TASK-001", addresses: { issues: [], validation: [], requirements: [] }, context: [], routing: { capability: "balanced", effort: "medium", reason: ["verificationDifficulty:2"] } }], traceability: { issueToValidation: [], requirementLinks: { schemaVersion: 1, links: [] } }, routingRecommendations: [{ taskId: "TASK-001" }] };
    expect(validateTraceability(plan)).toContainEqual(expect.objectContaining({ code: value.expected }));
    expect(value.activatedIn).toBe("TASK-036");
  });

  it("protects critic actionability by rejecting an item mapped to neither a task nor an issue", async () => {
    const value = fixture("unmapped-critic-item.json");
    const unmapped = { id: "CRIT-UNMAPPED", category: "weak_verification" as const, blocking: true, summary: "Confident but unactionable.", taskIds: [], issueIds: [] };
    const node = criticNode({
      protocolVersion: "1.0.0",
      protocolHash: "c".repeat(64),
      runtime: { async critique() { return {}; } },
      schema: { parse() { return { items: [unmapped], summary: "review" }; } },
    });
    const result = await node.run(
      { plan: { tasks: [{ id: "TASK-1" }] }, validationContract: {}, canonicalIssues: [{ candidateId: "ISSUE-1" }], necessaryContext: [] },
      { requirement: { deepMode: true }, planner: { id: "planner", capability: "balanced", independenceGroup: "group-a" }, pool: [{ id: "critic", capability: "frontier", independenceGroup: "group-b", available: true }] },
    );
    expect(result).toMatchObject({ status: "completed", critique: { items: [] }, rejected: [{ item: { id: "CRIT-UNMAPPED" }, code: value.expected }] });
    expect(value.activatedIn).toBe("TASK-038");
  });

  it("protects bounded-review invariant by terminating at three rounds with explicit non-consensus", async () => {
    const value = fixture("round-cap.json"); const auditor = await fakeAuditor<readonly PeerIssueOperation[]>([[], [], [], [], [], []]);
    const result = await runPeerReview(board(false), { auditors: auditors(3), rng, runtime: { review: (request) => auditor.audit(request) }, apply: async (current) => current, maximumRounds: 3 });
    expect(result.rounds).toBe(3);
    expect(result.consensus.candidates[0]?.outcome).toBe(value.expected);
    expect(auditor.networkRequests).toBe(0);
  });
});

interface TestAuditor<T> { readonly networkRequests: 0; audit(request: unknown): Promise<T> }
interface EnvelopeFunctions {
  readonly deriveEnvelope: (issues: readonly { id: string; accepted: boolean; locations: readonly { path?: string; moduleId?: string }[] }[], modules: readonly { id: string; files: readonly string[] }[]) => { readonly paths: readonly string[] };
  readonly intersectScope: (proposed: readonly string[], envelope: { readonly paths: readonly string[] }) => { readonly granted: readonly string[]; readonly displayedOnly: readonly string[] };
}
async function fakeAuditor<T>(responses: readonly T[]): Promise<TestAuditor<T>> {
  const moduleUrl = new URL("../../../testing/src/scripted-auditor.ts", import.meta.url).href;
  const loaded = await import(moduleUrl) as { scriptedAuditor<TResponse>(steps: readonly { type: "response"; value: TResponse }[]): TestAuditor<TResponse> };
  return loaded.scriptedAuditor(responses.map((value) => ({ type: "response" as const, value })));
}
function submission(startLine: number, endLine: number): FindingSubmission { return { auditorId: "auditor-a", repairCount: 1, finding: { sourceFindingId: "auditor-a/SEC-1", severity: "high", productionBlocker: false, locations: [{ id: "L-1", path: "src/auth.ts", startLine, endLine }], evidence: [{ id: "E-1", text: "evidence", locationIds: ["L-1"] }] } }; }
function snapshot() { return { files: { "src/auth.ts": { lineCount: 3, lineStartBytes: [0, 6, 12], byteLength: 18 } } }; }
function footprints() { return { "auditor-a": { nodeId: "discover", ranges: [{ path: "src/auth.ts", start: 0, end: 18 }] } }; }
const store = { async persistRejection() { return "artifact:rejection"; } };
function board(withCounterEvidence = true, votes: ConsensusBoard["candidates"][string]["votes"] = [], lastChangedRound = 0): ConsensusBoard { return { candidates: { "C-1": { candidateId: "C-1", claim: { title: "claim", description: "description" }, sourceFindingIds: ["source/1"], severity: "medium", blocker: false, status: "open", votes, evidence: [], counterEvidence: withCounterEvidence ? [{ id: "E-counter" }] : [], firstSeenRound: 0, lastChangedRound } } }; }
function auditors(count = 2) { return ["a", "b", "c"].slice(0, count).map((id) => ({ auditorId: `auditor-${id}`, independenceGroup: `g${id}` })); }
const rng: ReviewRng = { forActivity() { return this; }, shuffle<T>(items: T[]): T[] { return items; } };
