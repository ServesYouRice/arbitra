import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { modelRequirements } from "../src/model-requirements.js";
import { modelFeaturePlan } from "../src/model-feature-plan.js";
import { modelFeatureExploration } from "../src/model-feature-exploration.js";
import { modelFeatureReview } from "../src/model-feature-review.js";
import { modelFeatureCritic } from "../src/model-feature-critic.js";
import type { FeatureReviewerResult } from "../src/feature-review.js";
import type { FeatureReview } from "@arbitra/schemas/feature-review.js";
import { RunStore } from "../src/run-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each([false, true])("generates and replays Feature stages with follow-up review: %s", async (followup) => {
  const root = await mkdtemp(join(tmpdir(), "model-requirements-test-")); roots.push(root);
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("MODEL_ABSENT");
  const config = runConfigSchema.parse({ ...example, mode: "feature", models: { requirements: profile, "reviewer-a": { ...profile, independenceGroup: "reviewer-a" }, "reviewer-b": { ...profile, independenceGroup: "reviewer-b" } }, workflow: { modelExecution: {
    endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
    modelEndpoints: { requirements: "primary", "reviewer-a": "primary", "reviewer-b": "primary" }, maximumOutputTokens: 2000, maximumTokens: 1000000, maximumRetries: 0, timeoutMs: 1000,
    rateLimits: { [profile.provider]: { rpm: 100, tpm: 1000000, maxConcurrent: 4 } },
  } } });
  let calls = 0;
  const draft = { assumptions: [{ id: "assumption", statement: "Preserve existing sessions", confidence: "high" }], ambiguities: [{ id: "migration", question: "Migrate sessions?", proposedDefault: "Keep current sessions", blastRadius: "high" }], acceptance: [{ id: "acceptance", assertion: "New sessions work" }], outOfScope: [] };
  let output: unknown = draft;
  let reviewing = false; let reviewCalls = 0;
  const options = { modelProfileId: "requirements", mode: "interactive" as const, signal: new AbortController().signal, transport: {
    credential: () => "fixture-credential", client: { async send() {
      calls += 1;
      if (reviewing) reviewCalls += 1;
      const response = reviewing && followup && reviewCalls <= 2 ? { ...output as FeatureReview, decisions: (output as FeatureReview).decisions.map((decision) => ({ ...decision, disposition: "uncertain" })) } : output;
      return { status: 200, headers: {}, body: { output_text: JSON.stringify(response), usage: { input_tokens: 20, output_tokens: 30 } } };
    } },
  } };
  const snapshot = { root, files: [{ path: "session.ts", lines: ["export const version = 1;"], byteLength: 25, lineStartBytes: [0] }] };
  const store = new RunStore(root, "run");
  const initial = await modelRequirements(store, config, snapshot, options);
  const contract = await initial.open("Add session preferences");
  expect(contract.pendingAmbiguityIds).toEqual(["migration"]);
  await expect(initial.checkpoint.requireResolved()).rejects.toMatchObject({ state: "BLOCKED" });
  const plannerOptions = { ...options, exploration: { summary: "Session preferences", preflight: { affectedSurfaces: [{ id: "sessions", paths: ["session.ts"], riskCategories: [], relevantTo: ["acceptance"] }], securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1 }, evidence: [{ surfaceId: "sessions", path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }], limitations: [] } };
  await expect(modelFeaturePlan(store, config, snapshot, initial.checkpoint, plannerOptions)).rejects.toMatchObject({ state: "BLOCKED" });
  const restarted = await modelRequirements(new RunStore(root, "run"), config, snapshot, options);
  expect(await restarted.open("Add session preferences")).toEqual(contract);
  await restarted.checkpoint.approve(contract.artifactId, ["migration"]);
  expect((await restarted.checkpoint.requireResolved()).decision.acceptedDefaults).toEqual([{ ambiguityId: "migration", value: "Keep current sessions", acceptedBy: "operator" }]);
  expect(calls).toBe(1);
  const kinds = (await store.listArtifacts()).map(({ kind }) => kind);
  expect(kinds).toEqual(expect.arrayContaining(["model-protocol-feature-requirements", "feature-requirements-context", "model-token-budget"]));
  expect(kinds.some((kind) => kind.startsWith("compiled-prompt-"))).toBe(true);
  expect(kinds.some((kind) => kind.startsWith("harness-"))).toBe(true);
  output = plannerOptions.exploration;
  const explored = await modelFeatureExploration(store, config, snapshot, restarted.checkpoint, options);
  expect(explored.exploration).toEqual(plannerOptions.exploration);
  expect(explored.routing.targetedSurfaceIds).toEqual(["sessions"]);
  expect(await modelFeatureExploration(new RunStore(root, "run"), config, snapshot, restarted.checkpoint, options)).toEqual(explored);
  await expect(modelFeaturePlan(store, config, snapshot, restarted.checkpoint, plannerOptions)).rejects.toThrow("FEATURE_PLAN_REVIEW_REQUIRED");
  output = { summary: "Reviewed", decisions: ["assumption", "migration", "acceptance"].map((requirementId) => ({ requirementId, disposition: "accept", reason: "Consistent with request and source", proposedChange: null, evidence: [] })), limitations: [] };
  reviewing = true;
  const reviewOptions = { ...options, maximumRounds: 2, reviewerIds: ["reviewer-a", "reviewer-b"], exploration: explored.exploration };
  await expect(modelFeatureReview(store, config, snapshot, restarted.checkpoint, { ...reviewOptions, reviewerIds: ["reviewer-a", "reviewer-a"] })).rejects.toThrow("FEATURE_REVIEW_INDEPENDENCE_REQUIRED");
  const reviewed = await modelFeatureReview(store, config, snapshot, restarted.checkpoint, reviewOptions);
  expect(reviewed.blockingRequirementIds).toEqual([]);
  expect(await modelFeatureReview(new RunStore(root, "run"), config, snapshot, restarted.checkpoint, reviewOptions)).toEqual(reviewed);
  expect(reviewCalls).toBe(followup ? 4 : 2);
  reviewing = false;
  const reviewArtifact = (await store.listArtifacts()).find(({ kind }) => kind === "feature-review-consensus");
  if (reviewArtifact === undefined) throw new Error("REVIEW_ABSENT");
  const savedReview = await store.artifacts.get<{ inputFingerprint: string; reviewers: FeatureReviewerResult[] }>(reviewArtifact.ref);
  await store.publish("feature-review-consensus", { ...savedReview, inputFingerprint: "stale" });
  await expect(modelFeaturePlan(store, config, snapshot, restarted.checkpoint, plannerOptions)).rejects.toThrow("FEATURE_PLAN_REVIEW_STALE");
  await store.publish("feature-review-consensus", { ...savedReview, reviewers: savedReview.reviewers.map((reviewer) => ({ ...reviewer, review: { ...reviewer.review, decisions: reviewer.review.decisions.map((decision) => ({ ...decision, disposition: "uncertain" })) } })) });
  await expect(modelFeaturePlan(store, config, snapshot, restarted.checkpoint, plannerOptions)).rejects.toThrow("FEATURE_PLAN_REVIEW_UNRESOLVED");
  await store.publish("feature-review-consensus", savedReview);
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  plan.mode = "feature"; plan.acceptedIssueIds = []; plan.traceability.issueToValidation = [];
  plan.premiseReport = { status: "unavailable", interpretation: "smoke_test_only_not_proof", limitations: ["real_model_premise_requires_ground_truth_evaluation"] };
  for (const task of plan.tasks) { task.addresses.issues = []; task.addresses.requirements = ["acceptance"]; }
  plan.traceability.requirementLinks.links = [{ requirementId: "acceptance", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  output = plan;
  expect(await modelFeaturePlan(store, config, snapshot, restarted.checkpoint, plannerOptions)).toEqual(plan);
  expect(await modelFeaturePlan(new RunStore(root, "run"), config, snapshot, restarted.checkpoint, plannerOptions)).toEqual(plan);
  expect(calls).toBe(followup ? 7 : 5);
  expect((await store.listArtifacts()).some(({ kind }) => kind === "plan-ir")).toBe(true);
  const approved = await restarted.checkpoint.current();
  if (approved === null) throw new Error("CHECKPOINT_ABSENT");
  const revised = await restarted.checkpoint.revise(approved.artifactId, { ...draft, ambiguities: draft.ambiguities.map((ambiguity) => ({ ...ambiguity, proposedDefault: "Expire current sessions" })) });
  await expect(modelFeaturePlan(store, config, snapshot, restarted.checkpoint, plannerOptions)).rejects.toMatchObject({ state: "BLOCKED" });
  await restarted.checkpoint.approve(revised.artifactId, ["migration"]);
  await expect(modelFeaturePlan(store, config, snapshot, restarted.checkpoint, plannerOptions)).rejects.toThrow("FEATURE_PLAN_REVIEW_STALE");
  output = plannerOptions.exploration;
  await modelFeatureExploration(store, config, snapshot, restarted.checkpoint, options);
  output = { summary: "Reviewed revised default", decisions: ["assumption", "migration", "acceptance"].map((requirementId) => ({ requirementId, disposition: "accept", reason: "Revised contract is consistent", proposedChange: null, evidence: [] })), limitations: [] };
  reviewing = true;
  await modelFeatureReview(store, config, snapshot, restarted.checkpoint, reviewOptions);
  reviewing = false; output = plan;
  expect(await modelFeaturePlan(store, config, snapshot, restarted.checkpoint, plannerOptions)).toEqual(plan);
  expect(calls).toBe(followup ? 11 : 9);
  const criticOptions = { ...options, plannerProfileId: "requirements", criticProfileId: "reviewer-a", exploration: explored.exploration };
  await expect(modelFeatureCritic(store, config, snapshot, restarted.checkpoint, { ...plan, title: "Changed plan" }, criticOptions)).rejects.toThrow("FEATURE_CRITIC_PLAN_STALE");
  await expect(modelFeatureCritic(store, config, snapshot, restarted.checkpoint, plan, { ...criticOptions, criticProfileId: "requirements" })).rejects.toThrow("FEATURE_CRITIC_INDEPENDENCE_REQUIRED");
  output = { summary: "Feature plan critique", items: followup ? [{ id: "critique", category: "weak_verification", blocking: true, summary: "Add migration validation", taskIds: ["TASK-001"], issueIds: [] }] : [] };
  const critique = await modelFeatureCritic(store, config, snapshot, restarted.checkpoint, plan, criticOptions);
  expect(critique.passed).toBe(!followup);
  expect(await modelFeatureCritic(new RunStore(root, "run"), config, snapshot, restarted.checkpoint, plan, criticOptions)).toEqual(critique);
  expect(calls).toBe(followup ? 12 : 10);
});
