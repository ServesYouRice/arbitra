import type { EffortLevel } from "@arbitra/providers/effort.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema, type EffortStage } from "@arbitra/schemas/provider-execution.js";

export type { EffortStage } from "@arbitra/schemas/provider-execution.js";

/**
 * The level a stage the configuration leaves out runs at. It is the audit depth's, as before depths became presets
 * of models and efforts, so a stored run asks for the efforts it asked for when it started: fast low, balanced
 * medium, deep high. `cheap` is new and writes every stage; a stage removed from it runs at medium, which is also
 * where the CLIs default most models.
 */
export function depthEffort(depth: RunConfig["auditDepth"]): EffortLevel {
  return depth === "fast" ? "low" : depth === "deep" ? "high" : "medium";
}

/** Stages that run at another stage's effort when the configuration leaves them out. */
const FOLLOWS: Partial<Record<EffortStage, EffortStage>> = Object.freeze({ secondOpinion: "verification", critiqueCheck: "verification" });

/**
 * The effort one model profile is asked for at one stage (`workflow.modelExecution.stageEffort`): the stage's level,
 * or its level for that profile; else, for the second opinion and the critique check, verification's; else the
 * audit depth's. A call without a stage runs at the depth's level.
 */
export function stageEffort(config: RunConfig, stage: EffortStage | undefined, profileId: string): EffortLevel {
  const configured = config.workflow["modelExecution"] === undefined ? undefined : providerExecutionSchema.parse(config.workflow["modelExecution"]).stageEffort;
  const levelOf = (name: EffortStage | undefined): EffortLevel | undefined => {
    const value = name === undefined ? undefined : configured?.[name];
    if (value === undefined || typeof value === "string") return value;
    return Object.hasOwn(value, profileId) ? value[profileId] : undefined;
  };
  return levelOf(stage) ?? levelOf(stage === undefined ? undefined : FOLLOWS[stage]) ?? depthEffort(config.auditDepth);
}
