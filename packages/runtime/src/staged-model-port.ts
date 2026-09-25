import { createHash } from "node:crypto";
import type { PinnedProtocol } from "@arbitra/protocols/registry.js";
import { allocateModelContext, withinStringBudget } from "./model-context.js";
import { isCapacityError, ModelOutputLimitError } from "./context-budget.js";
import type { ModelActivityRequest } from "./model-activities.js";
import type { ModelHarness } from "./model-harness.js";
import type { PlannerCompositionPort, PlannerStage } from "./planner-context.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";

export interface HarnessStagePortOptions {
  readonly store: RunStore;
  readonly harness: ModelHarness;
  readonly snapshot: RepositorySnapshot;
  readonly protocol: PinnedProtocol;
  readonly modelProfileId: string;
  readonly signal: AbortSignal;
  readonly effort?: "low" | "medium" | "high";
  readonly maximumInputTokens: number;
  /** Durable identity prefix for staged activities, e.g. `feature/planner/<fingerprint>`. */
  readonly stagePrefix: string;
  /** Mode-specific rules appended to every staged instruction. */
  readonly instructionSuffix: string;
  readonly artifactPrefix: string;
  readonly nodeId: string;
  /** The pre-existing one-call activity. It keeps its identity, prompt and context artifact. */
  readonly full: { readonly stageActivityId: string; readonly activityId: string; readonly instruction: string; readonly input: unknown; readonly schema: { parse(value: unknown): unknown }; readonly outputSchema: unknown; readonly contextArtifact: string };
}

/** Durable model port for staged composition behind Feature/Testing harness stages.
 * Source files stay optional/excerptable; mandatory stage records must fit whole. */
export function harnessStagePort(options: HarnessStagePortOptions): PlannerCompositionPort {
  const { protocol } = options;
  const isFull = (stage: PlannerStage) => stage.activityId === options.full.stageActivityId;
  const activityId = (stage: PlannerStage) => isFull(stage) ? options.full.activityId : `${options.stagePrefix}/${stage.activityId}`;
  const request = (stage: PlannerStage, payload: unknown): ModelActivityRequest<unknown> => ({
    activityId: activityId(stage), modelProfileId: options.modelProfileId, signal: options.signal, effort: options.effort ?? "high",
    protocol: `${protocol.protocolId}@${protocol.protocolVersion}`, protocolAsset: protocol,
    protocolIdentity: { protocolId: protocol.protocolId, protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash },
    schema: isFull(stage) ? options.full.schema : stage.schema, outputSchema: isFull(stage) ? options.full.outputSchema : stage.jsonSchema, messages: [
      { role: "system", content: isFull(stage) ? options.full.instruction : `${stage.instruction} ${options.instructionSuffix} Source may be excerpted; consult contextCoverage and read-only source tools. Return only JSON matching the locked schema.` },
      { role: "user", content: JSON.stringify(payload) },
    ] });
  const repository = options.snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n"), trust: "untrusted_data" }));
  const allocate = async (stage: PlannerStage) => {
    if (await options.harness.outputLimited(activityId(stage))) throw new ModelOutputLimitError(activityId(stage));
    const input = isFull(stage) ? options.full.input : stage.input;
    const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : { input };
    return allocateModelContext({ ...record, repository }, (payload) => withinStringBudget(payload, options.maximumInputTokens) && options.harness.estimateInitialTokens(request(stage, payload)) <= options.maximumInputTokens);
  };
  return {
    async fits(stage) {
      try { await allocate(stage); return true; }
      catch (error) { if (isCapacityError(error)) return false; throw error; }
    },
    async call(stage) {
      const allocated = await allocate(stage);
      const kind = isFull(stage) ? options.full.contextArtifact : `${options.full.contextArtifact}-${createHash("sha256").update(activityId(stage)).digest("hex").slice(0, 24)}`;
      await options.store.publish(kind, { ...(isFull(stage) ? {} : { activityId: activityId(stage) }), ...allocated.coverage, maximumEstimatedTokens: options.maximumInputTokens }, options.nodeId);
      return options.harness.invoke(request(stage, allocated.input));
    },
    publish: (kind, value) => options.store.publish(`${options.artifactPrefix}${kind}`, value, options.nodeId),
  };
}
