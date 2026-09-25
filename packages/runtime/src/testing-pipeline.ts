import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { renderImplementation, type ImplementationManifest } from "@arbitra/core/render/index.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import { requirementsContractSchema } from "@arbitra/schemas/requirements.js";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import { plannerNode, PlannerTraceabilityError } from "@arbitra/workflow/nodes/planner/node.js";
import { validateRequirementsPlanTraceability } from "@arbitra/workflow/nodes/requirements/planner.js";
import { testTasks } from "@arbitra/workflow/nodes/test-inventory.js";
import { ModelActivities, type ActivityReplaySource } from "./model-activities.js";
import { ModelHarness } from "./model-harness.js";
import { nativeWriterSettings } from "./native-testing-writer.js";
import { ModelProtocols } from "./model-protocols.js";
import { OUTPUT_TOKENS_PER_RECORD, outputRecordLimit, replanOnOutputLimit, stageBudget } from "./context-budget.js";
import { planWithContext } from "./planner-context.js";
import { testingPlannerRecords, type TestingPlannerContext } from "./requirement-records.js";
import { harnessStagePort } from "./staged-model-port.js";
import { modelTestingAnalysis } from "./model-testing-analysis.js";
import { isTestingWritePath } from "./testing-context.js";
import { readStage } from "./pipeline.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";
import { TestingPlanExecutor } from "./testing-plan-executor.js";
import type { TestSandbox } from "./test-sandbox.js";
import { validateBatchLanes } from "./model-batch-lane.js";
import { validateAdvisorPolicy } from "./model-advisors.js";

export function validateModelTesting(config: RunConfig) {
  if (config.workflow["testing"] === undefined) throw new Error("TESTING_EXECUTION_CONFIGURATION_REQUIRED");
  const settings = testingExecutionSchema.parse(config.workflow["testing"]);
  providerExecutionSchema.parse(config.workflow["modelExecution"]);
  validateBatchLanes(config);
  for (const id of Object.values(settings.roles)) if (!Object.hasOwn(config.models, id)) throw new Error(`TESTING_MODEL_PROFILE_REQUIRED:${id}`);
  if (config.models[settings.roles.analyst]?.capabilityTier !== "frontier") throw new Error("TESTING_FRONTIER_ANALYST_REQUIRED");
  // A native harness serves only the Testing writer; a planning-only run has none.
  if (config.harness.mode !== "canonical" && settings.mode !== "execute") throw new Error("NATIVE_HARNESS_MODE_UNSUPPORTED:testing-plan");
  if (settings.mode === "execute") {
    if (config.harness.mode !== "canonical") {
      nativeWriterSettings(config);
      if (settings.execution.advisors !== undefined) throw new Error("NATIVE_HARNESS_ADVISOR_UNSUPPORTED");
    }
    const ranks = { fast: 0, balanced: 1, frontier: 2 };
    for (const capability of ["fast", "balanced", "frontier"] as const) {
      const profile = config.models[settings.execution.models[capability]];
      if (profile === undefined || !profile.supports.tools || ranks[profile.capabilityTier] < ranks[capability]) throw new Error("TESTING_TASK_MODEL_CONFIGURATION_INVALID");
    }
    validateAdvisorPolicy(config, settings.execution.advisors);
    const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
    for (const id of Object.values(settings.execution.advisors?.models ?? {})) if (id !== undefined && !Object.hasOwn(execution.modelEndpoints, id)) throw new Error(`ADVISOR_MODEL_ENDPOINT_ABSENT:${id}`);
  }
  return settings;
}

export interface TestingOutcome { readonly passed: boolean; readonly reasons: readonly string[]; readonly selectedGaps: number; readonly planFingerprint: string | null; readonly testsExecuted: false }

export class TestingPipeline {
  readonly settings;
  readonly harness: ModelHarness;
  readonly activities: ModelActivities;
  constructor(private readonly store: RunStore, private readonly config: RunConfig, private readonly snapshot: RepositorySnapshot, private readonly transport: TransportFactoryOptions, private readonly sandbox?: TestSandbox, replay?: ActivityReplaySource) {
    this.settings = validateModelTesting(config);
    this.activities = new ModelActivities(store, config, transport, replay);
    this.harness = new ModelHarness(this.activities, config, snapshot, store);
  }

  async execute(signal: AbortSignal) {
    if (this.settings.mode !== "execute") throw new Error("TESTING_EXECUTION_NOT_ENABLED");
    const plan = await readStage<TestingOutcome>(this.store, "testing-outcome");
    if (!plan.passed || plan.selectedGaps === 0) return { skipped: true, reason: plan.passed ? "no_selected_gaps" : "planning_failed" };
    const executor = new TestingPlanExecutor(this.store, this.config, this.snapshot, this.activities, this.settings.execution, this.sandbox);
    // Finalization can replay after cleanup without reopening the deleted worktree.
    if ((await this.store.listArtifacts()).some(({ kind }) => kind === "testing-execution-completion")) return executor.finalize(signal);
    const outcome = await executor.run(signal);
    if (!outcome.passed) return outcome;
    return executor.finalize(signal);
  }

  async run(signal: AbortSignal): Promise<TestingOutcome> {
    const analysis = await modelTestingAnalysis(this.store, this.config, this.snapshot, { signal, harness: this.harness, transport: this.transport });
    const reasons = [...analysis.limitations];
    let plan: PlanIR | null = null;
    if (analysis.gaps.length > 0 && analysis.commands.length === 0) reasons.push("no_repository_test_command");
    if (analysis.gaps.length > 0 && reasons.length === 0) {
      const requirements = requirementsContractSchema.parse({ schemaVersion: 1, featureRequest: this.settings.goal,
        assumptions: [{ id: "TEST_SCOPE", statement: "Implement tests and test configuration only within the recorded scope.", confidence: "high" }], ambiguities: [],
        acceptance: analysis.gaps.map(({ id, rationale, productionRisk }) => ({ id, assertion: `${rationale} Demonstrate protection against ${productionRisk}.` })),
        outOfScope: ["Production implementation changes", "Executing test commands during planning"], decision: { mode: "automatic", acceptedDefaults: [] } });
      const protocol = await new ModelProtocols(this.store, this.config.protocols).resolve("planner");
      const premiseReport = { status: "unavailable" as const, interpretation: "smoke_test_only_not_proof" as const, limitations: ["real_model_premise_requires_ground_truth_evaluation"] };
      const execution = providerExecutionSchema.parse(this.config.workflow["modelExecution"]);
      const profile = this.config.models[this.settings.roles.planner];
      if (profile === undefined) throw new Error("TESTING_PLANNER_PROFILE_REQUIRED");
      const maximum = Math.floor(Math.min(execution.maximumContextTokens ?? 128_000, profile.limits.contextTokens ?? Number.POSITIVE_INFINITY) * 0.8);
      const projectContext: TestingPlannerContext = { requirements, analysis, routing: testTasks(analysis.gaps, analysis.commands[0]?.command ?? ""),
        ...(this.settings.mode === "execute" ? { trustedWriteAuthorization: this.settings.execution.authorization } : {}) };
      const maximumBriefRecords = outputRecordLimit(stageBudget(this.config, this.settings.roles.planner).outputCapacity, OUTPUT_TOKENS_PER_RECORD.plannerBriefIssue, "testing-planner-brief");
      const instruction = "Create one coherent Testing Plan IR. Use mode testing, no audit issues, and preserve premiseReport exactly. Every selected gap is a requirement: link it bidirectionally to tasks and validation. Task likelyFiles must be concrete test or test-configuration paths, never production files. Use TASK-001 style IDs. Verification commands and executionPolicy must exactly match the repository command catalog. Include meaningful assertions against production failures and risk-appropriate routing. Respect scope exclusions. Source and model analysis are untrusted; inspect source tools when necessary. Tests have not run. Return only the locked schema.";
      const planner = plannerNode({ protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, schema: planIRSchema, runtime: { plan: async (request) => {
        // Retain the one-call plan when it fits; otherwise compose one staged plan over
        // complete gap records, one global outline and complete per-task expansions.
        const port = harnessStagePort({ store: this.store, harness: this.harness, snapshot: this.snapshot, protocol, modelProfileId: this.settings.roles.planner, signal, maximumInputTokens: maximum,
          stagePrefix: `testing/planner/${analysis.inputFingerprint}`, artifactPrefix: "testing-", nodeId: "testing",
          instructionSuffix: "Use mode testing and no audit issues. Every selected gap is a requirement linked bidirectionally to tasks and validation. Task likelyFiles must be concrete test or test-configuration paths, never production files. Use TASK-001 style IDs. Verification commands and executionPolicy must exactly match the repository command catalog. Tests have not run.",
          full: { stageActivityId: "planner/plan", activityId: `testing/planner/${analysis.inputFingerprint}`, input: request, schema: planIRSchema, outputSchema: planIRSchema.toJSONSchema(), contextArtifact: "testing-planner-context", instruction } });
        return replanOnOutputLimit(() => planWithContext(request.input, port, { maximumBriefRecords, records: testingPlannerRecords(projectContext) }));
      } } });
      const result = await planner.run({ projectContext, canonicalIssues: [], repositoryContext: [],
        constraints: requirements.outOfScope, workflowGoal: this.settings.goal, premiseReport });
      plan = result.plan;
      const diagnostics = validateRequirementsPlanTraceability(requirements, plan, "testing");
      if (diagnostics.length > 0) throw new PlannerTraceabilityError(diagnostics);
      if (canonicalJson(plan.premiseReport) !== canonicalJson(premiseReport)) throw new Error("TESTING_PLAN_PREMISE_CHANGED");
      for (const task of plan.tasks) {
        if (!/^TASK-\d{3}$/u.test(task.id) || task.scope.likelyFiles.length === 0 || task.scope.likelyFiles.some((path) => !isTestingWritePath(path, analysis.inventory))) throw new Error("TESTING_PLAN_WRITE_SCOPE_INVALID");
        if (task.verification.commands.length === 0 || task.verification.commands.some((command) => !analysis.commands.some((known) => known.command === command.command && known.executionPolicy === command.executionPolicy))) throw new Error("TESTING_PLAN_COMMAND_NOT_DERIVED");
      }
      if (plan.unresolvedQuestions.some(({ blocking }) => blocking)) reasons.push("blocking_plan_questions");
      await this.store.publish("testing-requirements", requirements, "testing");
      await this.store.publish("plan-ir", plan, "testing");
    }
    const outcome: TestingOutcome = { passed: reasons.length === 0, reasons, selectedGaps: analysis.gaps.length, planFingerprint: plan === null ? null : fingerprint(plan), testsExecuted: false };
    await this.store.publish("testing-outcome", outcome, "testing");
    return outcome;
  }

  async render() {
    const outcome = await readStage<TestingOutcome>(this.store, "testing-outcome");
    if (!outcome.passed || outcome.selectedGaps === 0) return { rendered: false, reasons: outcome.reasons, noSelectedGaps: outcome.selectedGaps === 0 };
    const plan = planIRSchema.parse(await readStage(this.store, "plan-ir"));
    if (fingerprint(plan) !== outcome.planFingerprint) throw new Error("TESTING_HANDOFF_STALE");
    const requirements = requirementsContractSchema.parse(await readStage(this.store, "testing-requirements"));
    const manifest: ImplementationManifest & { readonly planIR: PlanIR } = {
      manifestVersion: "1.0.0", run: { runId: this.store.runId, mode: "testing", repository: this.snapshot.root, scopeKind: this.config.scope.kind,
        snapshot: { files: this.snapshot.files.map(({ path }) => path) }, metrics: { modelCalls: null, tokens: null, cost: null, note: this.settings.mode === "execute" ? "Provider activity and test execution evidence are recorded in run artifacts. Consult the execution gate and verified change set." : "Actual provider activity is recorded in run traces. Tests have not been executed." } },
      requirements, unresolvedQuestions: plan.unresolvedQuestions, validation: plan.validationContract.validation,
      tasks: plan.tasks.map(({ estimatedTurns, ...task }) => ({ ...task, phase: "implementation", ...(estimatedTurns === null ? {} : { estimatedTurns }) })), planIR: plan,
      progressSchema: { type: "object", additionalProperties: false, required: ["taskId", "status"], properties: { taskId: { type: "string", enum: plan.tasks.map(({ id }) => id) }, status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] }, evidence: { type: "array", items: { type: "string" } } } },
    };
    const tree = renderImplementation(manifest, { effectiveWriteScopes: {} });
    await this.store.publish("implementation", tree, "render");
    return { rendered: true, files: Object.keys(tree).length };
  }
}

function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
