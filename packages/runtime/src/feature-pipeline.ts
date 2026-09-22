import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { RunCheckpointError } from "@arbitra/core/runner/suspension.js";
import { renderImplementation, type ImplementationManifest } from "@arbitra/core/render/index.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { featureExecutionSchema } from "@arbitra/schemas/feature-execution.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import type { PlanIR } from "@arbitra/schemas/plan.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import { modelRequirements } from "./model-requirements.js";
import { modelFeatureExploration } from "./model-feature-exploration.js";
import { modelFeatureReview } from "./model-feature-review.js";
import { modelFeaturePlan } from "./model-feature-plan.js";
import { modelFeaturePlanning } from "./model-feature-planning.js";
import { featureReviewInputFingerprint } from "./feature-review.js";
import { readStage } from "./pipeline.js";
import type { RunStore } from "./run-store.js";
import type { RepositorySnapshot } from "./repository.js";
import { ModelHarness } from "./model-harness.js";
import { ModelActivities } from "./model-activities.js";
import { modelRequirementsRevision } from "./model-requirements-revision.js";
import { applyRequirementsProposal, requirementsRevisionContext } from "./requirements-revision.js";

export function validateModelFeature(config: RunConfig) {
  if (config.workflow["feature"] === undefined) throw new Error("FEATURE_EXECUTION_CONFIGURATION_REQUIRED");
  const feature = featureExecutionSchema.parse(config.workflow["feature"]);
  providerExecutionSchema.parse(config.workflow["modelExecution"]);
  for (const id of [feature.roles.requirements, feature.roles.exploration, feature.roles.planner, feature.roles.critic, ...feature.roles.reviewers]) {
    if (id !== undefined && !Object.hasOwn(config.models, id)) throw new Error(`FEATURE_MODEL_PROFILE_REQUIRED:${id}`);
  }
  if (feature.roles.reviewers.length > 0 && (feature.roles.reviewers.length < 2 || new Set(feature.roles.reviewers.map((id) => config.models[id]?.independenceGroup)).size !== feature.roles.reviewers.length)) throw new Error("FEATURE_REVIEW_INDEPENDENCE_REQUIRED");
  if (feature.roles.critic !== undefined && (feature.roles.planner === feature.roles.critic || config.models[feature.roles.planner]?.independenceGroup === config.models[feature.roles.critic]?.independenceGroup)) throw new Error("FEATURE_CRITIC_INDEPENDENCE_REQUIRED");
  return feature;
}

export interface FeatureOutcome {
  readonly inputFingerprint: string;
  readonly planFingerprint: string;
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly reviewRequired: boolean;
  readonly revisionCalls: number;
}

/** The shared runner owns this dynamic subgraph. A blocked subgraph is re-entered
 * after an operator edit; stage identities reuse only outputs for the current contract. */
export class FeaturePipeline {
  readonly settings;
  readonly harness: ModelHarness;
  constructor(private readonly store: RunStore, private readonly config: RunConfig, private readonly snapshot: RepositorySnapshot, private readonly transport: TransportFactoryOptions) {
    this.settings = validateModelFeature(config);
    this.harness = new ModelHarness(new ModelActivities(store, config, transport), config, snapshot, store);
  }

  async requirements(signal: AbortSignal) {
    return modelRequirements(this.store, this.config, this.snapshot, { modelProfileId: this.settings.roles.requirements, mode: this.settings.mode, signal, harness: this.harness, transport: this.transport });
  }

  async applyRequirementsRevision(artifactId: string) {
    const { checkpoint } = await this.requirements(new AbortController().signal);
    return applyRequirementsProposal(this.store, checkpoint, artifactId, this.snapshot);
  }

  async run(signal: AbortSignal): Promise<FeatureOutcome> {
    const stages = await this.requirements(signal);
    await stages.open(this.settings.request);
    await stages.checkpoint.requireResolved();
    const { roles } = this.settings;
    const options = { signal, transport: this.transport, harness: this.harness };
    let explored = await modelFeatureExploration(this.store, this.config, this.snapshot, stages.checkpoint, { ...options, modelProfileId: roles.exploration });
    let reviewRequired = explored.routing.stages.includes("targeted_review") || (await this.store.listArtifacts()).some(({ kind }) => kind === "feature-requirements-revisions");
    while (reviewRequired) {
      const revisionContext = await requirementsRevisionContext(this.store, await stages.checkpoint.requireResolved());
      const consensus = await modelFeatureReview(this.store, this.config, this.snapshot, stages.checkpoint, { ...options, reviewerIds: roles.reviewers, exploration: explored.exploration, ...(revisionContext === undefined ? {} : { revisionContext }) });
      if (consensus.blockingRequirementIds.length > 0 || consensus.limitations.length > 0) {
        const current = await stages.checkpoint.current();
        if (current === null) throw new Error("REQUIREMENTS_CHECKPOINT_ABSENT");
        await this.store.publish("feature-requirements-blocker", { artifactId: current.artifactId, reason: "requirements_review_unresolved", consensus }, "feature");
        const proposal = await modelRequirementsRevision(this.store, this.config, this.snapshot, stages.checkpoint, { ...options, exploration: explored.exploration, maximumRevisions: this.settings.maximumRequirementsRevisions, modelProfileId: roles.requirements });
        if (proposal === null || this.settings.mode === "interactive") throw new RunCheckpointError(current.artifactId);
        await applyRequirementsProposal(this.store, stages.checkpoint, proposal.artifactId, this.snapshot);
        explored = await modelFeatureExploration(this.store, this.config, this.snapshot, stages.checkpoint, { ...options, modelProfileId: roles.exploration });
        reviewRequired = true;
      } else break;
    }
    let plan: PlanIR;
    let revisionCalls = 0;
    const reasons: string[] = [...(explored.exploration.limitations.length > 0 ? ["limited_feature_exploration"] : [])];
    if (reviewRequired) {
      if (roles.critic === undefined) throw new Error("FEATURE_CRITIC_PROFILE_REQUIRED");
      const planned = await modelFeaturePlanning(this.store, this.config, this.snapshot, stages.checkpoint, { ...options, plannerProfileId: roles.planner, criticProfileId: roles.critic, exploration: explored.exploration });
      plan = planned.plan;
      revisionCalls = planned.revisionCalls;
      if (planned.review.result.degradedReviewCoverage) reasons.push("degraded_critic_coverage");
      if (planned.review.result.status === "completed" && planned.review.result.critique.items.some(({ blocking }) => blocking)) reasons.push("blocking_critic_feedback");
      if (!planned.review.passed && reasons.length === 0 && !plan.unresolvedQuestions.some(({ blocking }) => blocking)) reasons.push("feature_plan_review_failed");
    } else {
      plan = await modelFeaturePlan(this.store, this.config, this.snapshot, stages.checkpoint, { ...options, modelProfileId: roles.planner, exploration: explored.exploration });
      await this.store.publish("feature-review-skipped", { reason: "bounded_requirements_and_low_risk", routing: explored.routing }, "feature");
    }
    if (plan.unresolvedQuestions.some(({ blocking }) => blocking)) reasons.push("blocking_plan_questions");
    const requirements = await stages.checkpoint.requireResolved();
    const outcome: FeatureOutcome = { inputFingerprint: featureReviewInputFingerprint(requirements, explored.exploration, this.snapshot),
      planFingerprint: fingerprint(plan), passed: reasons.length === 0, reasons, reviewRequired, revisionCalls };
    await this.store.publish("feature-outcome", outcome, "feature");
    return outcome;
  }

  async render() {
    const outcome = await readStage<FeatureOutcome>(this.store, "feature-outcome");
    if (!outcome.passed) return { rendered: false, reasons: outcome.reasons };
    const plan = await readStage<PlanIR>(this.store, "plan-ir");
    const stages = await this.requirements(new AbortController().signal);
    const requirements = await stages.checkpoint.requireResolved();
    const exploration = await readStage(this.store, "feature-exploration");
    if (fingerprint(plan) !== outcome.planFingerprint || featureReviewInputFingerprint(requirements, exploration, this.snapshot) !== outcome.inputFingerprint) throw new Error("FEATURE_HANDOFF_STALE");
    const manifest: ImplementationManifest & { readonly planIR: PlanIR } = {
      manifestVersion: "1.0.0", run: { runId: this.store.runId, mode: "feature", repository: this.snapshot.root, scopeKind: this.config.scope.kind,
        snapshot: { files: this.snapshot.files.map(({ path }) => path) }, metrics: { modelCalls: null, tokens: null, cost: null, note: "Actual provider activity is recorded in run traces. Tests have not been executed." } },
      requirements, unresolvedQuestions: plan.unresolvedQuestions, validation: plan.validationContract.validation,
      tasks: plan.tasks.map(({ estimatedTurns, ...task }) => ({ ...task, phase: "implementation", ...(estimatedTurns === null ? {} : { estimatedTurns }),
        verification: { ...task.verification, commands: task.verification.commands.map((command) => ({ ...command, executionPolicy: "requires_approval" })) } })),
      planIR: plan,
      progressSchema: { type: "object", additionalProperties: false, required: ["taskId", "status"], properties: { taskId: { type: "string", enum: plan.tasks.map(({ id }) => id) }, status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] }, evidence: { type: "array", items: { type: "string" } } } },
    };
    // Exportable artifacts stay under the run; no repository files are overwritten.
    const tree = renderImplementation(manifest, { effectiveWriteScopes: {} });
    await this.store.publish("implementation", tree, "render");
    return { rendered: true, files: Object.keys(tree).length };
  }
}

function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
