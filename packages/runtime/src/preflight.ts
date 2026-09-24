import type { RunnerGraph } from "@arbitra/core/runner/workflow-runner.js";
import { resolveEffort, type EffortLevel } from "@arbitra/providers/effort.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import type { ModelProfile } from "@arbitra/schemas/model-profile.js";
import { providerExecutionSchema, type ProviderExecution } from "@arbitra/schemas/provider-execution.js";
import { featureExecutionSchema } from "@arbitra/schemas/feature-execution.js";
import { testingExecutionSchema } from "@arbitra/schemas/testing.js";
import { verificationExecutionSchema, type VerificationExecution } from "@arbitra/schemas/verification-execution.js";
import { concreteWritePath } from "@arbitra/security/write-partitions";
import { auditorIdsFor, graphForPreset } from "./graphs.js";
import type { TestSandbox } from "./test-sandbox.js";
import { validateBatchLanes } from "./model-batch-lane.js";
import { validateAdvisorPolicy } from "./model-advisors.js";

/**
 * Runtime preflight: everything that can be established about a configuration before
 * a run exists, a snapshot is taken, or a provider/sandbox is contacted.
 *
 * Configuration diagnostics are pure. Environment diagnostics read only whether a
 * credential variable is set (never its value) and ask the sandbox, when it supports
 * inspection, whether the engine and pinned image are already present locally.
 */
export type PreflightSeverity = "error" | "warning";
export interface PreflightDiagnostic {
  readonly code: string;
  readonly severity: PreflightSeverity;
  /** Configuration problems need an edit; environment problems need setup on this host. */
  readonly scope: "configuration" | "environment";
  /** Dotted configuration path the operator should edit, or `$environment`. */
  readonly path: string;
  /** What is wrong and what to change. Never contains a credential value. */
  readonly message: string;
}

export class PreflightError extends Error {
  readonly statusCode = 400;
  readonly diagnostics: readonly PreflightDiagnostic[];
  constructor(diagnostics: readonly PreflightDiagnostic[]) {
    const errors = diagnostics.filter(({ severity }) => severity === "error");
    super(errors.map(({ code, path, message }) => `${code} at ${path}: ${message}`).join("\n") || "RUNTIME_PREFLIGHT_FAILED");
    this.name = "PreflightError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export function assertNoPreflightErrors(diagnostics: readonly PreflightDiagnostic[]): void {
  if (diagnostics.some(({ severity }) => severity === "error")) throw new PreflightError(diagnostics);
}

const error = (code: string, path: string, message: string): PreflightDiagnostic => Object.freeze({ code, severity: "error", scope: "configuration", path, message });
const warning = (code: string, path: string, message: string): PreflightDiagnostic => Object.freeze({ code, severity: "warning", scope: "configuration", path, message });

/** The graph a configuration executes, including operator-registered presets. Mode and preset must agree. */
export function graphForConfiguration(config: RunConfig, registered: Readonly<Record<string, RunnerGraph>> = {}): RunnerGraph {
  if (config.workflow["preset"] !== undefined && typeof config.workflow["preset"] !== "string") throw new Error("INVALID_WORKFLOW_PRESET");
  const testingPreset = config.mode === "testing" && testingExecutionSchema.parse(config.workflow["testing"]).mode === "execute" ? "testing-execute" : "testing-plan";
  const preset = typeof config.workflow["preset"] === "string" ? config.workflow["preset"] : undefined;
  const graph = preset !== undefined && Object.hasOwn(registered, preset) ? registered[preset] as RunnerGraph : graphForPreset(preset ?? (config.mode === "feature" ? "feature-simple" : config.mode === "testing" ? testingPreset : undefined));
  if ((graph.id === "feature-simple") !== (config.mode === "feature")) throw new Error("WORKFLOW_PRESET_MODE_MISMATCH");
  if ((graph.id === "testing-plan" || graph.id === "testing-execute") !== (config.mode === "testing") || config.mode === "testing" && graph.id !== testingPreset) throw new Error("WORKFLOW_PRESET_MODE_MISMATCH");
  return graph;
}

export interface ConfigurationPreflightOptions {
  /** Operator-registered graphs dispatched by preset ID. */
  readonly graphs?: Readonly<Record<string, RunnerGraph>>;
  /** Validates the graph's gate/human checkpoints against `workflow.checkpoints`; throws on failure. */
  readonly checkpoints?: (graph: RunnerGraph) => void;
}

/** Collects every configuration problem the runtime would otherwise report one at a time. */
export function configurationDiagnostics(config: RunConfig, options: ConfigurationPreflightOptions = {}): readonly PreflightDiagnostic[] {
  const diagnostics: PreflightDiagnostic[] = [];
  if (config.harness.mode !== "canonical") {
    diagnostics.push(error("RUNTIME_NATIVE_HARNESS_NOT_AVAILABLE", "harness.mode", "Native harness adapters are not implemented. Set harness.mode to \"canonical\"; no native tool loop is ever substituted silently."));
  }
  const modelBacked = config.mode !== "audit" || Object.keys(config.models).length > 0;
  unenforcedSectionDiagnostics(config, modelBacked, diagnostics);
  const graph = presetDiagnostics(config, options.graphs ?? {}, diagnostics);
  if (graph !== undefined && options.checkpoints !== undefined) {
    try { options.checkpoints(graph); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      diagnostics.push(error(codeOf(message, "CHECKPOINT_POLICY_INVALID"), "workflow.checkpoints", `${message}. Every gate node needs a known deterministic gate policy and every human node a decision policy in workflow.checkpoints; decisions may name only human nodes of graph ${graph.id}.`));
    }
  }
  if (!modelBacked) return Object.freeze(diagnostics);
  const execution = executionOf(config, diagnostics);
  if (execution?.batch !== undefined) {
    try { validateBatchLanes(config); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      diagnostics.push(error(codeOf(message, "BATCH_LANE_INVALID"), "workflow.modelExecution.batch", `${message}. A batch lane must name a configured, endpoint-bound profile that declares supports.batch, on a transport with a batch driver.`));
    }
  }
  if (config.mode === "audit") auditDiagnostics(config, graph, execution, diagnostics);
  if (config.mode === "feature") featureDiagnostics(config, diagnostics);
  if (config.mode === "testing") testingDiagnostics(config, diagnostics);
  return Object.freeze(diagnostics);
}

/**
 * The schema accepts these sections as free-form JSON, but no runtime stage reads them. A
 * cost cap or exclusion list that silently does nothing is worse than none, so they are
 * reported: a spend limit the runtime would ignore blocks a model-backed run outright.
 */
function unenforcedSectionDiagnostics(config: RunConfig, modelBacked: boolean, diagnostics: PreflightDiagnostic[]): void {
  if (Object.keys(config.budgets).length > 0) {
    const message = "budgets is not enforced: no stage reads maximumCostUsd, maximumModelCalls or any other key here. The enforced spend limits are workflow.modelExecution.maximumTokens (the run token budget), maximumOutputTokens and maximumRetries; a cost cap in currency is not implemented. Set budgets to {}.";
    diagnostics.push(modelBacked ? error("BUDGETS_NOT_ENFORCED", "budgets", message) : warning("BUDGETS_NOT_ENFORCED", "budgets", `${message} This scripted run makes no model calls.`));
  }
  if (Object.keys(config.security).length > 0) {
    diagnostics.push(warning("SECURITY_SETTINGS_NOT_ENFORCED", "security", "security is not enforced: excludeGlobs and the other keys here do not remove files from the snapshot. Narrow the source with scope (module or diff scope) and keep secrets out of the repository; secret redaction applies regardless. Set security to {}."));
  }
  if (Object.keys(config.contextPolicies).length > 0) {
    diagnostics.push(warning("CONTEXT_POLICIES_NOT_ENFORCED", "contextPolicies", "contextPolicies is not read: each stage's context is fixed by its workflow (discovery is always independent). Set contextPolicies to {}."));
  }
}

/** Stable code prefix of a runtime error message such as `CODE:detail`. */
function codeOf(message: string, fallback: string): string {
  const code = message.split(":")[0] ?? "";
  return /^[A-Z][A-Z0-9_]+$/u.test(code) ? code : fallback;
}

function presetDiagnostics(config: RunConfig, registered: Readonly<Record<string, RunnerGraph>>, diagnostics: PreflightDiagnostic[]): RunnerGraph | undefined {
  if (config.mode === "testing" && config.workflow["testing"] === undefined) return undefined;
  try { return graphForConfiguration(config, registered); }
  catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    if (message.startsWith("UNKNOWN_WORKFLOW_PRESET:")) diagnostics.push(error("UNKNOWN_WORKFLOW_PRESET", "workflow.preset", `${message.slice("UNKNOWN_WORKFLOW_PRESET:".length)} is not an executable preset. Use audit-balanced, audit-deep, diff-fast, diff-review, feature-simple, testing-plan, testing-execute or a graph registered with the orchestrator.`));
    else if (message === "WORKFLOW_PRESET_MODE_MISMATCH") diagnostics.push(error("WORKFLOW_PRESET_MODE_MISMATCH", "workflow.preset", `Preset ${String(config.workflow["preset"])} does not execute mode ${config.mode}. Audit uses an audit or diff preset, Feature uses feature-simple, Testing uses testing-plan with testing.mode "plan" or testing-execute with testing.mode "execute".`));
    else if (message === "INVALID_WORKFLOW_PRESET") diagnostics.push(error("INVALID_WORKFLOW_PRESET", "workflow.preset", "workflow.preset must be a preset name string."));
    else diagnostics.push(error("INVALID_WORKFLOW_CONFIGURATION", "workflow", message));
    return undefined;
  }
}

function executionOf(config: RunConfig, diagnostics: PreflightDiagnostic[]): ProviderExecution | undefined {
  if (config.workflow["modelExecution"] === undefined) {
    diagnostics.push(error("RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED", "workflow.modelExecution", "Model-backed runs need workflow.modelExecution: endpoints (with apiKeyEnvVar names), modelEndpoints binding every profile, maximumOutputTokens, maximumTokens, timeoutMs, maximumRetries and rateLimits. Remove every model profile to run the scripted Audit instead."));
    return undefined;
  }
  const parsed = providerExecutionSchema.safeParse(config.workflow["modelExecution"]);
  return parsed.success ? parsed.data : undefined;
}

const DEPTH_EFFORT = { fast: "low", balanced: "medium", deep: "high" } as const;

function auditDiagnostics(config: RunConfig, graph: RunnerGraph | undefined, execution: ProviderExecution | undefined, diagnostics: PreflightDiagnostic[]): void {
  if (graph === undefined || execution === undefined) return;
  const auditors = auditorIdsFor(graph);
  const criticEnabled = graph.nodes.some(({ id }) => id === "critic");
  for (const id of auditors) {
    if (!Object.hasOwn(config.models, id)) diagnostics.push(error(`MODEL_PROFILE_REQUIRED:${id}`, `models.${id}`, `Preset ${graph.id} dispatches discovery to profiles ${auditors.join(", ")}. Add a profile named ${id} and bind it in workflow.modelExecution.modelEndpoints.`));
  }
  const roles = execution.roles;
  if (roles === undefined) {
    diagnostics.push(error("MODEL_EXECUTION_ROLES_REQUIRED", "workflow.modelExecution.roles", `Model Audit needs explicit roles: planner and verifier${criticEnabled ? ", and critic for this preset" : ""}. Each names a configured profile ID; nothing is selected implicitly.`));
  } else if (criticEnabled && roles.critic === undefined) {
    diagnostics.push(error("MODEL_CRITIC_PROFILE_REQUIRED", "workflow.modelExecution.roles.critic", `Preset ${graph.id} runs a plan critic. Set roles.critic to a configured profile, preferably from a different independenceGroup than roles.planner.`));
  }
  const effort = DEPTH_EFFORT[config.auditDepth];
  const used = new Set([...auditors, ...Object.values(roles ?? {})].filter((id): id is string => id !== undefined && Object.hasOwn(config.models, id)));
  for (const id of used) effortDiagnostic(config, id, [effort], `auditDepth ${config.auditDepth}`, diagnostics);
}

function featureDiagnostics(config: RunConfig, diagnostics: PreflightDiagnostic[]): void {
  if (config.workflow["feature"] === undefined) {
    diagnostics.push(error("FEATURE_EXECUTION_CONFIGURATION_REQUIRED", "workflow.feature", "Feature mode needs workflow.feature with request, mode (\"interactive\" or \"automatic\") and roles {requirements, exploration, planner, reviewers, critic}."));
    return;
  }
  const parsed = featureExecutionSchema.safeParse(config.workflow["feature"]);
  if (!parsed.success) return;
  const { roles } = parsed.data;
  for (const [role, id] of [["requirements", roles.requirements], ["exploration", roles.exploration], ["planner", roles.planner], ["critic", roles.critic], ...roles.reviewers.map((reviewer) => ["reviewers", reviewer] as const)] as const) {
    if (id !== undefined && !Object.hasOwn(config.models, id)) diagnostics.push(error(`FEATURE_MODEL_PROFILE_REQUIRED:${id}`, `workflow.feature.roles.${role}`, `Role ${role} names ${id}, which is not a configured model profile.`));
  }
  if (roles.reviewers.length > 0 && (roles.reviewers.length < 2 || new Set(roles.reviewers.map((id) => config.models[id]?.independenceGroup)).size !== roles.reviewers.length)) {
    diagnostics.push(error("FEATURE_REVIEW_INDEPENDENCE_REQUIRED", "workflow.feature.roles.reviewers", "Targeted requirements review needs at least two reviewers whose profiles declare distinct independenceGroup values. Omit reviewers only for low-risk Features."));
  }
  if (roles.critic !== undefined && (roles.planner === roles.critic || config.models[roles.planner]?.independenceGroup === config.models[roles.critic]?.independenceGroup)) {
    diagnostics.push(error("FEATURE_CRITIC_INDEPENDENCE_REQUIRED", "workflow.feature.roles.critic", "The Feature critic must be a different profile from the planner, with a different independenceGroup."));
  }
  if (roles.reviewers.length === 0 || roles.critic === undefined) {
    diagnostics.push(warning("FEATURE_REVIEW_ROLES_ABSENT", "workflow.feature.roles", "Without two reviewers and a critic only low-risk Features can pass; a risk-directed review will fail explicitly."));
  }
  effortDiagnostic(config, roles.requirements, ["medium", "high"], "requirements drafting and revision", diagnostics);
  effortDiagnostic(config, roles.exploration, ["medium"], "exploration", diagnostics);
  effortDiagnostic(config, roles.planner, ["high"], "planning", diagnostics);
  if (roles.critic !== undefined) effortDiagnostic(config, roles.critic, ["high"], "plan criticism", diagnostics);
  for (const id of roles.reviewers) effortDiagnostic(config, id, ["high"], "requirements review", diagnostics);
}

const TIER_RANK = { fast: 0, balanced: 1, frontier: 2 } as const;

function testingDiagnostics(config: RunConfig, diagnostics: PreflightDiagnostic[]): void {
  if (config.workflow["testing"] === undefined) {
    diagnostics.push(error("TESTING_EXECUTION_CONFIGURATION_REQUIRED", "workflow.testing", "Testing mode needs workflow.testing with mode (\"plan\" or \"execute\"), goal, roles {analyst, planner} and optional evidence-backed commands."));
    return;
  }
  const parsed = testingExecutionSchema.safeParse(config.workflow["testing"]);
  if (!parsed.success) return;
  const settings = parsed.data;
  for (const [role, id] of Object.entries(settings.roles)) {
    if (!Object.hasOwn(config.models, id)) diagnostics.push(error(`TESTING_MODEL_PROFILE_REQUIRED:${id}`, `workflow.testing.roles.${role}`, `Role ${role} names ${id}, which is not a configured model profile.`));
  }
  const analyst = config.models[settings.roles.analyst];
  if (analyst !== undefined && analyst.capabilityTier !== "frontier") {
    diagnostics.push(error("TESTING_FRONTIER_ANALYST_REQUIRED", "workflow.testing.roles.analyst", `Testing risk analysis requires a profile declared capabilityTier "frontier"; ${settings.roles.analyst} declares "${analyst.capabilityTier}".`));
  }
  effortDiagnostic(config, settings.roles.analyst, ["high"], "Testing risk analysis", diagnostics);
  effortDiagnostic(config, settings.roles.planner, ["high"], "Testing planning", diagnostics);
  if (settings.mode !== "execute") return;
  for (const capability of ["fast", "balanced", "frontier"] as const) {
    const id = settings.execution.models[capability];
    const path = `workflow.testing.execution.models.${capability}`;
    const profile = Object.hasOwn(config.models, id) ? config.models[id] : undefined;
    if (profile === undefined) { diagnostics.push(error("TESTING_TASK_MODEL_CONFIGURATION_INVALID", path, `${id} is not a configured model profile.`)); continue; }
    if (!profile.supports.tools) diagnostics.push(error("TESTING_TASK_MODEL_CONFIGURATION_INVALID", path, `Testing writers edit files only through leased tools; ${id} must declare supports.tools true.`));
    if (TIER_RANK[profile.capabilityTier] < TIER_RANK[capability]) diagnostics.push(error("TESTING_TASK_MODEL_CONFIGURATION_INVALID", path, `${capability} tasks need a profile at or above that tier; ${id} declares "${profile.capabilityTier}".`));
    if (capability === "frontier") effortDiagnostic(config, id, ["high"], "Testing frontier tasks", diagnostics);
    // Other writers receive the planned task's routing effort, which is unknown until planning.
    else effortDiagnostic(config, id, ["low", "medium", "high", "xhigh"], `Testing ${capability} tasks (planned routing effort)`, diagnostics, "warning");
  }
  const advisors = settings.execution.advisors;
  if (advisors !== undefined) {
    try { validateAdvisorPolicy(config, advisors); }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      diagnostics.push(error(codeOf(message, "ADVISOR_MODEL_CONFIGURATION_INVALID"), "workflow.testing.execution.advisors", `${message}. Each advisor tier must name a configured profile at or above that tier whose declared limits admit the advisor's maximumOutputTokens and maximumContextTokens.`));
    }
    const bindings = config.workflow["modelExecution"] === undefined ? undefined : providerExecutionSchema.safeParse(config.workflow["modelExecution"]);
    for (const [tier, id] of Object.entries(advisors.models)) {
      if (id !== undefined && bindings?.success === true && !Object.hasOwn(bindings.data.modelEndpoints, id)) diagnostics.push(error(`ADVISOR_MODEL_ENDPOINT_ABSENT:${id}`, `workflow.testing.execution.advisors.models.${tier}`, `Advisor profile ${id} has no endpoint in workflow.modelExecution.modelEndpoints.`));
    }
  }
  const { verification } = settings.execution;
  const boundChecks = verification.execution.checks.filter(({ id }) => verification.bindings.some(({ checkId }) => checkId === id));
  for (const [index, partition] of settings.execution.authorization.partitions.entries()) {
    for (const path of partition.paths) {
      if (!boundChecks.some(({ sourcePaths }) => sourcePaths.includes(path))) {
        diagnostics.push(error("TESTING_WRITE_WITHOUT_VERIFICATION_CHECK", `workflow.testing.execution.authorization.partitions.${index}.paths`, `${path} is writable but no command-bound sandbox check lists it in sourcePaths, so its changes could never be verified. Add it to a check's sourcePaths or remove the grant.`));
      }
      try { concreteWritePath(path); }
      catch (failure) {
        diagnostics.push(error("TESTING_WRITE_PATH_INVALID", `workflow.testing.execution.authorization.partitions.${index}.paths`, `${failure instanceof Error ? failure.message : String(failure)}. Write grants are exact repository-relative file paths; directories, globs and control-plane paths are not granted.`));
      }
    }
  }
}

function effortDiagnostic(config: RunConfig, id: string, levels: readonly EffortLevel[], purpose: string, diagnostics: PreflightDiagnostic[], severity: PreflightSeverity = "error"): void {
  const profile: ModelProfile | undefined = Object.hasOwn(config.models, id) ? config.models[id] : undefined;
  if (profile === undefined) return;
  for (const level of levels) {
    try { resolveEffort(profile, level); }
    catch {
      diagnostics.push((severity === "error" ? error : warning)(`MODEL_EFFORT_UNSUPPORTED:${id}`, `models.${id}.effort`, `${purpose} ${severity === "error" ? "requests" : "may request"} effort "${level}". Add it to effort.supported, or declare effort.collapse.${level} naming a supported level; collapse is recorded per call, never silent.`));
      return;
    }
  }
}

export interface EnvironmentPreflightOptions {
  readonly credential: (environmentName: string) => string | undefined;
  readonly sandbox?: Pick<TestSandbox, "inspect">;
  readonly signal?: AbortSignal;
  /** False skips checks whose failure is only a warning (Audit's optional sandbox). */
  readonly includeWarnings?: boolean;
  /** True when requests would reach real provider endpoints (no injected HTTP client). */
  readonly liveDispatch?: boolean;
}

/** Shipped templates name no real model; a live request must never be sent for one. */
export const MODEL_IDENTITY_PLACEHOLDER_PREFIX = "replace-with-";

/** Credentials and local sandbox prerequisites. Reports presence only, never values. */
export async function environmentDiagnostics(config: RunConfig, options: EnvironmentPreflightOptions): Promise<readonly PreflightDiagnostic[]> {
  const diagnostics: PreflightDiagnostic[] = [];
  const parsed = config.workflow["modelExecution"] === undefined ? undefined : providerExecutionSchema.safeParse(config.workflow["modelExecution"]);
  const modelBacked = config.mode !== "audit" || Object.keys(config.models).length > 0;
  if (modelBacked && options.liveDispatch === true) {
    for (const [id, profile] of Object.entries(config.models)) {
      if (profile.modelId.startsWith(MODEL_IDENTITY_PLACEHOLDER_PREFIX) || profile.family.startsWith(MODEL_IDENTITY_PLACEHOLDER_PREFIX)) {
        diagnostics.push(error(`MODEL_IDENTITY_PLACEHOLDER:${id}`, `models.${id}.modelId`, "This profile still names a template placeholder. Set modelId and family, and review supports, limits and effort, from your provider's documentation before a live run; arbitra ships no model catalogue."));
      }
    }
  }
  if (modelBacked && parsed?.success === true) {
    const execution = parsed.data;
    for (const [index, endpoint] of execution.endpoints.entries()) {
      const models = Object.entries(execution.modelEndpoints).filter(([, endpointId]) => endpointId === endpoint.id).map(([id]) => id);
      if (models.length === 0) continue;
      const value = options.credential(endpoint.apiKeyEnvVar);
      if (value === undefined || value.length === 0) {
        diagnostics.push(error(`PROVIDER_CREDENTIAL_MISSING:${endpoint.id}`, `workflow.modelExecution.endpoints.${index}.apiKeyEnvVar`, `Environment variable ${endpoint.apiKeyEnvVar} is not set for endpoint ${endpoint.id} (profiles ${models.join(", ")}). Export it in the process that runs arbitra; the value is read only at dispatch and never written to configuration, runs or responses.`));
      }
    }
  }
  const sandbox = sandboxRequirement(config);
  if (sandbox !== undefined && (sandbox.required || options.includeWarnings !== false) && options.sandbox?.inspect !== undefined) {
    const availability = await options.sandbox.inspect(sandbox.execution.image, options.signal ?? new AbortController().signal);
    const make = sandbox.required ? error : warning;
    const consequence = sandbox.required ? "Testing execution cannot verify changes without it" : "Audit verification checks will be recorded as unavailable coverage gaps";
    if (availability.engine === "unavailable") {
      diagnostics.push(make("SANDBOX_ENGINE_UNAVAILABLE", "$environment", `A running local Linux Docker engine is required for ${sandbox.path}. ${consequence}. Start Docker and confirm \`docker info --format '{{.OSType}}'\` prints linux.${availability.detail === null ? "" : ` Detail: ${availability.detail}`}`));
    } else if (availability.image === "absent") {
      diagnostics.push(make(`SANDBOX_IMAGE_UNAVAILABLE:${sandbox.execution.image}`, `${sandbox.path}.image`, `The pinned image is not present locally and arbitra never pulls or builds images. ${consequence}. Pull or load it yourself so that \`docker image inspect ${sandbox.execution.image}\` succeeds; the image must already contain the test dependencies.`));
    }
  }
  return Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, scope: "environment" as const })));
}

function sandboxRequirement(config: RunConfig): { readonly execution: VerificationExecution; readonly path: string; readonly required: boolean } | undefined {
  if (config.mode === "testing") {
    const testing = testingExecutionSchema.safeParse(config.workflow["testing"]);
    if (testing.success && testing.data.mode === "execute") return { execution: testing.data.execution.verification.execution, path: "workflow.testing.execution.verification.execution", required: true };
    return undefined;
  }
  if (config.mode !== "audit" || config.verification["execution"] === undefined) return undefined;
  const execution = verificationExecutionSchema.safeParse(config.verification["execution"]);
  if (!execution.success || execution.data.checks.length === 0 || execution.data.maximumRuns === 0) return undefined;
  return { execution: execution.data, path: "verification.execution", required: false };
}
