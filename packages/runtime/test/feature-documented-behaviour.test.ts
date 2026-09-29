import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { modelRequirements } from "../src/model-requirements.js";
import { modelFeatureExploration } from "../src/model-feature-exploration.js";
import { modelFeatureReview } from "../src/model-feature-review.js";
import { RunStore } from "../src/run-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// The live fixture: the request and the doc comment say a session has expired at expiresAt, and the
// requirements model adopted the code, which keeps it valid (observed twice; Haiku reviewers accepted both).
const lines = ["/** A session is valid strictly before its expiry instant. */", "export function isExpired(session, now) {", "  return now > session.expiresAt;", "}"];

it("repairs a misquoted documented-behaviour conflict and never accepts the requirement it names", async () => {
  const root = await mkdtemp(join(tmpdir(), "feature-documented-behaviour-")); roots.push(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("MODEL_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "feature", models: { requirements: profile, "reviewer-a": { ...profile, independenceGroup: "reviewer-a" }, "reviewer-b": { ...profile, independenceGroup: "reviewer-b" } }, workflow: { modelExecution: {
    endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
    modelEndpoints: { requirements: "primary", "reviewer-a": "primary", "reviewer-b": "primary" }, maximumOutputTokens: 2000, maximumTokens: 1000000, maximumRetries: 0, maximumOutputRepairs: 1, timeoutMs: 30_000,
    rateLimits: { [profile.provider]: { rpm: 100, tpm: 1000000, maxConcurrent: 4 } },
  } } });
  const responses: unknown[] = []; const bodies: string[] = [];
  const options = { modelProfileId: "requirements", mode: "interactive" as const, signal: new AbortController().signal, transport: {
    credential: () => "fixture-credential", client: { async send(request: { body?: unknown }) {
      bodies.push(JSON.stringify(request.body));
      const response = responses.shift();
      if (response === undefined) throw new Error("UNEXPECTED_MODEL_CALL");
      return { status: 200, headers: {}, body: { output_text: JSON.stringify(response), usage: { input_tokens: 20, output_tokens: 30 } } };
    } },
  } };
  const snapshot = { root, files: [{ path: "src/session.js", lines, byteLength: Buffer.byteLength(lines.join("\n")), lineStartBytes: lines.map((_, index) => lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)) }] };
  const store = new RunStore(root, "run");
  responses.push({ assumptions: [{ id: "A1", statement: "Callers supply the current time", confidence: "high" }], ambiguities: [], acceptance: [{ id: "AC1", assertion: "isExpired is false when now equals expiresAt" }], outOfScope: [] });
  const stages = await modelRequirements(store, config, snapshot, options);
  await stages.open("Enforce expiry exactly at expiresAt.");
  expect(bodies[0]).toContain("Current code shows what the code does, not what it should do.");

  const conflict = { requirementIds: ["AC1"], documentation: { path: "src/session.js", startLine: 1, endLine: 1, text: lines[0] ?? "" },
    code: { path: "src/session.js", startLine: 3, endLine: 3, text: "return now > session.expiresAt;" }, explanation: "AC1 keeps a session valid at expiresAt; the doc comment says it has expired." };
  const exploration = { summary: "Session expiry", preflight: { affectedSurfaces: [{ id: "expiry", paths: ["src/session.js"], riskCategories: [], relevantTo: ["AC1"] }], securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1 },
    evidence: [{ surfaceId: "expiry", path: "src/session.js", startLine: 2, endLine: 3, text: `${lines[1]}\n${lines[2]}` }], limitations: [] };
  // The first reply misquotes the code; the refusal is repaired inside the call instead of failing the stage.
  responses.push({ ...exploration, documentedBehaviourConflicts: [{ ...conflict, code: { ...conflict.code, text: "return now >= session.expiresAt;" } }] }, { ...exploration, documentedBehaviourConflicts: [conflict] });
  const explored = await modelFeatureExploration(store, config, snapshot, stages.checkpoint, options);
  expect(explored.exploration.documentedBehaviourConflicts).toEqual([conflict]);
  expect(bodies.at(-1)).toContain("DOCUMENTED_BEHAVIOUR_CONFLICT_UNGROUNDED");

  // Both reviewers accept everything, as the Haiku reviewers did live; the conflict still blocks AC1,
  // and no further review round is spent on a requirement only a revision or the operator can settle.
  const accept = { summary: "Reviewed", decisions: ["A1", "AC1"].map((requirementId) => ({ requirementId, disposition: "accept", reason: "Matches the current code", proposedChange: null, evidence: [] })), limitations: [], documentedBehaviourConflicts: [] };
  responses.push(accept, accept);
  const consensus = await modelFeatureReview(store, config, snapshot, stages.checkpoint, { ...options, maximumRounds: 3, reviewerIds: ["reviewer-a", "reviewer-b"], exploration: explored.exploration });
  expect(consensus.blockingRequirementIds).toEqual(["AC1"]);
  expect(consensus.decisions.find(({ requirementId }) => requirementId === "AC1")).toMatchObject({ disposition: "unresolved", documentedBehaviourConflicts: [{ reportedBy: "exploration", requirementIds: ["AC1"] }] });
  const record = (await store.listArtifacts()).find(({ kind }) => kind === "feature-review-consensus");
  expect(record === undefined ? null : await store.artifacts.get(record.ref)).toMatchObject({ explorationConflicts: [conflict] });
  expect(responses).toEqual([]);
});
