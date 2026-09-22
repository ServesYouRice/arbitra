import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { featureFixture } from "./feature-fixture.js";
import { orchestratorCore } from "../src/cli-core.js";
import { Orchestrator } from "../src/orchestrator.js";
import { runConfigSchema } from "@arbitra/schemas/config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(options: Parameters<typeof featureFixture>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "feature-orchestrator-")); roots.push(root);
  return { root, ...await featureFixture(root, options) };
}

it.each([false, true])("runs a public Feature with risk-directed review and a durable handoff: %s", async (highRisk) => {
  const f = await fixture({ highRisk }); const core = f.orchestrator();
  expect(await core.estimate(f.config)).toMatchObject({ estimate: { auditors: 0, providerCalls: null } });
  const result = await core.run(f.config);
  expect(result.state).toBe("COMPLETED");
  expect(await core.gate(result.runId)).toEqual({ gateStatus: "passed", reasons: [] });
  expect(f.calls.map(({ stage }) => stage).sort()).toEqual((highRisk ? ["requirements", "exploration", "review", "review", "planner", "critic"] : ["requirements", "exploration", "planner"]).sort());
  if (highRisk) expect(f.calls.some(({ url }) => url.includes("anthropic.fixture"))).toBe(true);
  const artifact = (await core.artifacts(result.runId)).find(({ kind }) => kind === "implementation");
  if (artifact === undefined) throw new Error("HANDOFF_ABSENT");
  const content = await core.artifact(result.runId, artifact.artifactId) as { content: string };
  const tree = JSON.parse(content.content) as Record<string, string>;
  expect(tree["context/requirements.md"]).toContain("New sessions work");
  expect(tree["tasks/TASK-001/task.md"]).toContain("TASK-001");
  expect(JSON.parse(tree["manifest.json"] ?? "{}")).toMatchObject({ run: { mode: "feature" }, planIR: { mode: "feature" }, requirements: { decision: { mode: "automatic" } } });
  expect(await f.orchestrator().gate(result.runId)).toEqual({ gateStatus: "passed", reasons: [] });
  await expect(core.replay(result.runId, { consensusPolicy: "full", maximumRounds: 1, criticEnabled: true })).rejects.toThrow("FEATURE_AUDIT_REPLAY_NOT_SUPPORTED");
});

it("suspends the CLI on approvals, rejects stale edits and resumes from a fresh orchestrator", async () => {
  const f = await fixture({ interactive: true }); const core = f.orchestrator();
  const path = join(f.root, "config.json"); await writeFile(path, JSON.stringify(f.config));
  const result = await orchestratorCore(core).run(path);
  expect(result.disposition).toBe("suspended");
  const resource = result.value as { runId: string; checkpoints: { artifactId: string }[] };
  const current = await core.requirements(resource.runId);
  if (current === null) throw new Error("CHECKPOINT_ABSENT");
  expect(resource.checkpoints).toMatchObject([{ artifactId: current.artifactId }]);
  expect(f.calls.map(({ stage }) => stage)).toEqual(["requirements"]);
  const next = await core.reviseRequirements(resource.runId, current.artifactId, { ...f.draft, ambiguities: [{ id: "migration", question: "Migrate?", proposedDefault: "Expire sessions", blastRadius: "high" }] });
  await expect(core.approveRequirements(resource.runId, { artifactId: current.artifactId, ambiguityIds: ["migration"] })).rejects.toThrow("STALE_REQUIREMENTS_CHECKPOINT");
  await core.approveRequirements(resource.runId, { artifactId: next.artifactId, ambiguityIds: ["migration"] });
  const restarted = f.orchestrator();
  await restarted.resume(resource.runId);
  expect((await restarted.wait(resource.runId)).state).toBe("COMPLETED");
  expect(f.calls.filter(({ stage }) => stage === "requirements")).toHaveLength(1);
  expect(await restarted.gate(resource.runId)).toMatchObject({ gateStatus: "passed" });
  await expect(restarted.reviseRequirements(resource.runId, next.artifactId, f.draft)).rejects.toThrow("REQUIREMENTS_EDIT_REQUIRES_BLOCKED_RUN");
});

it("re-enters a disputed requirements subgraph after revision without replaying stale downstream outputs", async () => {
  const f = await fixture({ highRisk: true, reviewBlocked: true }); const core = f.orchestrator();
  const result = await core.run(f.config); expect(result.state).toBe("BLOCKED");
  expect(f.calls.some(({ stage }) => stage === "planner")).toBe(false);
  const current = await core.requirements(result.runId); if (current === null) throw new Error("CHECKPOINT_ABSENT");
  await core.reviseRequirements(result.runId, current.artifactId, { ...f.draft, assumptions: [{ id: "assumption", statement: "Retain compatible session preferences", confidence: "high" }] });
  f.acceptReview();
  const restarted = f.orchestrator(); await restarted.resume(result.runId);
  expect((await restarted.wait(result.runId)).state).toBe("COMPLETED");
  expect(f.calls.filter(({ stage }) => stage === "exploration")).toHaveLength(2);
  expect(f.calls.filter(({ stage }) => stage === "review")).toHaveLength(4);
  expect(await restarted.gate(result.runId)).toMatchObject({ gateStatus: "passed" });
});

it("resumes provider failure without repeating completed requirements or exploration", async () => {
  const f = await fixture({ failPlanner: true }); const core = f.orchestrator();
  const result = await core.run(f.config); expect(result.state).toBe("FAILED");
  const restarted = f.orchestrator(); await restarted.resume(result.runId);
  expect((await restarted.wait(result.runId)).state).toBe("COMPLETED");
  expect(f.calls.map(({ stage }) => stage)).toEqual(["requirements", "exploration", "planner", "planner"]);
});

it.each(["critic", "question", "coverage"])("fails the gate and withholds execution handoff for %s blockers", async (kind) => {
  const f = await fixture({ highRisk: kind === "critic", criticBlocking: kind === "critic", questions: kind === "question", limited: kind === "coverage" }); const core = f.orchestrator();
  const result = await core.run(f.config); expect(result.state).toBe("COMPLETED");
  expect(await core.gate(result.runId)).toMatchObject({ gateStatus: "failed", reasons: expect.arrayContaining([kind === "critic" ? "blocking_critic_feedback" : kind === "question" ? "blocking_plan_questions" : "limited_feature_exploration"]) });
  expect((await core.artifacts(result.runId)).some(({ kind }) => kind === "implementation")).toBe(false);
  if (kind === "critic") { expect(f.calls.filter(({ stage }) => stage === "revision")).toHaveLength(1); expect(f.calls.filter(({ stage }) => stage === "critic")).toHaveLength(2); }
});

it("suspends Feature work before provider dispatch when its durable budget cannot admit the first request", async () => {
  const f = await fixture(); const core = f.orchestrator();
  const config = runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, modelExecution: { ...f.config.workflow["modelExecution"] as object, maximumTokens: 2000 } } });
  const result = await core.run(config); expect(result.state).toBe("SUSPENDED_BUDGET"); expect(f.calls).toHaveLength(0);
  const restarted = f.orchestrator(); await restarted.resume(result.runId);
  expect((await restarted.wait(result.runId)).state).toBe("SUSPENDED_BUDGET"); expect(f.calls).toHaveLength(0);
});

it("cancels a Feature provider call that ignores cancellation and publishes no handoff", async () => {
  const f = await fixture(); let dispatched: () => void = () => {};
  const sent = new Promise<void>((resolve) => { dispatched = resolve; });
  const core = new Orchestrator({ repository: f.root, providerOptions: { ...f.providerOptions, client: { async send() { dispatched(); return new Promise(() => {}); } } } });
  const started = await core.start(f.config); await sent;
  expect((await core.cancel(started.runId)).state).toBe("CANCELLED");
  expect((await core.artifacts(started.runId)).some(({ kind }) => kind === "implementation")).toBe(false);
});

it("rejects mismatched presets, malformed role bindings and insufficient reviewer independence", async () => {
  const f = await fixture(); const core = f.orchestrator();
  await expect(core.start({ ...f.config, workflow: { ...f.config.workflow, preset: "audit-deep" } })).rejects.toThrow("WORKFLOW_PRESET_MODE_MISMATCH");
  for (const roles of [
    { requirements: "unknown", exploration: "planner", planner: "planner" },
    { requirements: "planner", exploration: "planner", planner: "planner", reviewers: ["reviewer", "reviewer"] },
  ]) {
    expect(core.validate({ ...f.config, workflow: { ...f.config.workflow, feature: { request: "Feature", mode: "automatic", roles } } }).valid).toBe(false);
  }
  const config = runConfigSchema.parse({ ...f.config, models: { ...f.config.models, reviewer: { ...f.config.models["reviewer"], independenceGroup: "critic" } } });
  await expect(core.start(config)).rejects.toThrow("FEATURE_REVIEW_INDEPENDENCE_REQUIRED");
  expect(f.calls).toHaveLength(0);
});

it("keeps saved checkpoints readable after source changes while rejecting edits and resume", async () => {
  const f = await fixture({ interactive: true }); const core = f.orchestrator();
  const result = await core.run(f.config); expect(result.state).toBe("BLOCKED");
  const current = await core.requirements(result.runId); if (current === null) throw new Error("CHECKPOINT_ABSENT");
  await writeFile(join(f.root, "session.ts"), "export const version = 2;\n");
  expect(await f.orchestrator().requirements(result.runId)).toEqual(current);
  expect((await core.status(result.runId)).state).toBe("BLOCKED");
  await expect(core.approveRequirements(result.runId, { artifactId: current.artifactId, ambiguityIds: ["migration"] })).rejects.toThrow("RUN_REPOSITORY_CHANGED");
  await expect(core.resume(result.runId)).rejects.toThrow("RUN_REPOSITORY_CHANGED");
  expect(f.calls).toHaveLength(1);
});

it.each(["clean", "generation_failure", "review_failure"])("generates bounded requirements revisions and resumes durable stages: %s", async (failure) => {
  const f = await fixture({ highRisk: true, reviewBlocked: true, requirementsRevisions: 1, acceptRevision: true, failRequirementsRevision: failure === "generation_failure", failRevisionReview: failure === "review_failure" });
  const core = f.orchestrator(); const result = await core.run(f.config);
  if (failure !== "clean") {
    expect(result.state).toBe("FAILED");
    const restarted = f.orchestrator(); await restarted.resume(result.runId);
    expect((await restarted.wait(result.runId)).state).toBe("COMPLETED");
  } else expect(result.state).toBe("COMPLETED");
  expect(await core.gate(result.runId)).toMatchObject({ gateStatus: "passed" });
  const current = await core.requirements(result.runId);
  expect(current).toMatchObject({ contract: { assumptions: [{ statement: "Keep existing sessions Clarified." }], decision: { acceptedDefaults: [{ value: "Keep sessions revised", acceptedBy: "automatic_mode" }] } } });
  expect(current?.revisionProposal).toBeUndefined();
  expect(f.calls.filter(({ stage }) => stage === "requirements")).toHaveLength(1);
  expect(f.calls.filter(({ stage }) => stage === "requirements-revision")).toHaveLength(failure === "generation_failure" ? 2 : 1);
  expect(f.calls.filter(({ stage }) => stage === "exploration")).toHaveLength(2);
  const reviews = f.calls.filter(({ stage, input }) => stage === "review" && (input as { revisionContext?: unknown }).revisionContext !== undefined);
  expect(reviews).toHaveLength(failure === "review_failure" ? 3 : 2);
  expect(reviews[0]?.input).toMatchObject({ revisionContext: { originalRequirements: { assumptions: [{ statement: "Keep existing sessions" }] }, proposedResolutions: expect.arrayContaining([{ requirementId: "migration", resolution: "Clarified defaults against source" }]) } });
});

it("exhausts the persisted requirements revision limit without accepting continuing disagreement", async () => {
  const f = await fixture({ highRisk: true, reviewBlocked: true, requirementsRevisions: 2 }); const core = f.orchestrator();
  const result = await core.run(f.config); expect(result.state).toBe("BLOCKED");
  expect(f.calls.filter(({ stage }) => stage === "requirements-revision")).toHaveLength(2);
  expect(f.calls.some(({ stage }) => stage === "planner")).toBe(false);
  const calls = f.calls.length;
  const restarted = f.orchestrator(); await restarted.resume(result.runId);
  expect((await restarted.wait(result.runId)).state).toBe("BLOCKED"); expect(f.calls).toHaveLength(calls);
  expect(await restarted.gate(result.runId)).toMatchObject({ gateStatus: "failed" });
});

it("requires fresh independent review after revision history even when a subsequent draft routes FAST", async () => {
  const f = await fixture({ highRisk: true, reviewBlocked: true, requirementsRevisions: 1 }); const core = f.orchestrator();
  const result = await core.run(f.config); expect(result.state).toBe("BLOCKED");
  const current = await core.requirements(result.runId); if (current === null) throw new Error("CHECKPOINT_ABSENT");
  await core.reviseRequirements(result.runId, current.artifactId, { ...f.draft, ambiguities: [] });
  f.acceptReview(); const before = f.calls.filter(({ stage }) => stage === "review").length;
  await core.resume(result.runId); expect((await core.wait(result.runId)).state).toBe("COMPLETED");
  expect(f.calls.filter(({ stage }) => stage === "review")).toHaveLength(before + 2);
  expect(await core.summary(result.runId)).toMatchObject({ outcome: { reviewRequired: true, passed: true } });
  const route = (await core.artifacts(result.runId)).find(({ kind }) => kind === "feature-routing");
  if (route === undefined) throw new Error("ROUTING_ABSENT");
  const artifact = await core.artifact(result.runId, route.artifactId) as { content: string };
  expect(JSON.parse(artifact.content)).toMatchObject({ recommended: "FAST" });
});

it("leaves an interactive proposal unapplied until selected, renews approvals, and re-reviews it", async () => {
  const f = await fixture({ interactive: true, reviewBlocked: true, requirementsRevisions: 1, acceptRevision: true }); const core = f.orchestrator();
  const result = await core.run(f.config); expect(result.state).toBe("BLOCKED");
  const draft = await core.requirements(result.runId); if (draft === null) throw new Error("CHECKPOINT_ABSENT");
  const approved = await core.approveRequirements(result.runId, { artifactId: draft.artifactId, ambiguityIds: ["migration"] });
  await core.resume(result.runId); expect((await core.wait(result.runId)).state).toBe("BLOCKED");
  const proposed = await core.requirements(result.runId); const proposal = proposed?.revisionProposal;
  if (proposal === undefined) throw new Error("PROPOSAL_ABSENT");
  expect(proposed?.artifactId).toBe(approved.artifactId); expect(proposed?.contract).toEqual(approved.contract);
  expect((await core.status(result.runId)).checkpoints).toMatchObject([{ revisionProposalArtifactId: proposal.artifactId }]);
  const calls = f.calls.length;
  await core.resume(result.runId); expect((await core.wait(result.runId)).state).toBe("BLOCKED"); expect(f.calls).toHaveLength(calls);
  const restarted = f.orchestrator();
  const revised = await restarted.applyRequirementsRevision(result.runId, proposal.artifactId);
  expect(revised.pendingAmbiguityIds).toEqual(["migration"]); expect(revised.contract.decision.acceptedDefaults).toEqual([]);
  expect((await restarted.requirements(result.runId))?.revisionProposal).toBeUndefined();
  await expect(restarted.applyRequirementsRevision(result.runId, proposal.artifactId)).rejects.toThrow("STALE_REQUIREMENTS_CHECKPOINT");
  await restarted.approveRequirements(result.runId, { artifactId: revised.artifactId, ambiguityIds: ["migration"] });
  await restarted.resume(result.runId); expect((await restarted.wait(result.runId)).state).toBe("COMPLETED");
  expect(await restarted.gate(result.runId)).toMatchObject({ gateStatus: "passed" });
  expect(f.calls.filter(({ stage }) => stage === "requirements-revision")).toHaveLength(1);
});
