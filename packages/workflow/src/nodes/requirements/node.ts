import { requirementsDraftSchema, requirementsContractSchema } from "@arbitra/schemas/requirements.js";
import type {
  RequirementAcceptance,
  RequirementAmbiguity,
  RequirementAssumption,
  RequirementsContract,
  RequirementsMode,
} from "./types.js";

interface RequirementsModelOutput {
  readonly assumptions: readonly RequirementAssumption[];
  readonly ambiguities: readonly RequirementAmbiguity[];
  readonly outOfScope: readonly string[];
  readonly acceptance: readonly RequirementAcceptance[];
}

export interface RequirementsRequest {
  readonly featureRequest: string;
  readonly repositorySummary: unknown;
  readonly protocol: {
    readonly protocolId: "feature-requirements";
    readonly protocolVersion: string;
    readonly protocolHash: string;
  };
  readonly capability: "balanced";
  readonly outputSchema: "RequirementsContractDraft";
}

export interface RequirementsRuntime {
  generate(request: RequirementsRequest): Promise<unknown>;
}

export interface RequirementsSchema {
  parse(value: unknown): RequirementsModelOutput;
}

export interface RequirementsArtifactStore {
  persist(kind: "requirements-contract", contract: RequirementsContract): Promise<{ readonly artifactId: string }>;
  load?(artifactId: string): Promise<unknown>;
}

export interface RequirementsNodeConfig {
  readonly mode: RequirementsMode;
  readonly protocolVersion: string;
  readonly protocolHash: string;
  readonly runtime: RequirementsRuntime;
  readonly schema: RequirementsSchema;
  readonly artifacts: RequirementsArtifactStore;
}

export interface RequirementsNodeInput {
  readonly featureRequest: string;
  readonly repositorySummary: unknown;
  readonly operatorAcceptedDefaults?: readonly string[];
}

export function requirementsNode(config: RequirementsNodeConfig) {
  if (config.protocolVersion.trim() === "" || !/^[a-f0-9]{64}$/u.test(config.protocolHash)) {
    throw new Error("REQUIREMENTS_PROTOCOL_NOT_PINNED");
  }
  const complete = async (contract: RequirementsContract, modelCalls: number) => {
    requirementsContractSchema.parse(contract);
    const artifact = await config.artifacts.persist("requirements-contract", contract);
    const accepted = new Set(contract.decision.acceptedDefaults.map(({ ambiguityId }) => ambiguityId));
    const checkpoint = contract.decision.mode === "interactive"
      ? contract.ambiguities.filter(({ blastRadius, id }) => blastRadius === "high" && !accepted.has(id)) : [];
    return Object.freeze({ contract, artifact, modelCalls, checkpoint: checkpoint.length === 0 ? null : Object.freeze({
      kind: "high_impact_ambiguities" as const, ambiguityIds: Object.freeze(checkpoint.map(({ id }) => id)),
    }) });
  };
  return Object.freeze({
    async resume(input: { readonly artifactId: string; readonly operatorAcceptedDefaults: readonly string[] }) {
      if (config.mode !== "interactive") throw new Error("REQUIREMENTS_CHECKPOINT_NOT_INTERACTIVE");
      if (config.artifacts.load === undefined) throw new Error("REQUIREMENTS_ARTIFACT_LOAD_REQUIRED");
      const saved = requirementsContractSchema.parse(await config.artifacts.load(input.artifactId));
      if (saved.decision.mode !== "interactive") throw new Error("REQUIREMENTS_CHECKPOINT_NOT_INTERACTIVE");
      const accepted = new Set(input.operatorAcceptedDefaults);
      if (accepted.size !== input.operatorAcceptedDefaults.length || [...accepted].some((id) => !saved.ambiguities.some((ambiguity) => ambiguity.id === id))) throw new Error("INVALID_OPERATOR_ACCEPTED_DEFAULTS");
      for (const decision of saved.decision.acceptedDefaults) accepted.add(decision.ambiguityId);
      const contract: RequirementsContract = Object.freeze({ ...saved,
        assumptions: freezeEntries(saved.assumptions), ambiguities: freezeEntries(saved.ambiguities),
        outOfScope: Object.freeze([...saved.outOfScope]), acceptance: freezeEntries(saved.acceptance),
        decision: Object.freeze({ mode: "interactive" as const, acceptedDefaults: freezeEntries(saved.ambiguities.filter(({ id }) => accepted.has(id)).map(({ id, proposedDefault }) => ({ ambiguityId: id, value: proposedDefault, acceptedBy: "operator" as const }))) }),
      });
      return complete(contract, 0);
    },
    async run(input: RequirementsNodeInput) {
      if (input.featureRequest.trim() === "") throw new Error("FEATURE_REQUEST_REQUIRED");
      if ((input.operatorAcceptedDefaults?.length ?? 0) > 0) throw new Error("REQUIREMENTS_APPROVAL_REQUIRES_SAVED_CONTRACT");
      const draft = requirementsDraftSchema.parse(config.schema.parse(await config.runtime.generate(Object.freeze({
        featureRequest: input.featureRequest,
        repositorySummary: input.repositorySummary,
        protocol: Object.freeze({ protocolId: "feature-requirements" as const, protocolVersion: config.protocolVersion, protocolHash: config.protocolHash }),
        capability: "balanced" as const,
        outputSchema: "RequirementsContractDraft" as const,
      }))));
      const acceptedDefaults = draft.ambiguities
        .filter(() => config.mode === "automatic")
        .map((ambiguity) => Object.freeze({
          ambiguityId: ambiguity.id,
          value: ambiguity.proposedDefault,
          acceptedBy: config.mode === "automatic" ? "automatic_mode" as const : "operator" as const,
        }));
      const contract: RequirementsContract = Object.freeze({
        schemaVersion: 1 as const,
        featureRequest: input.featureRequest,
        assumptions: freezeEntries(draft.assumptions),
        ambiguities: freezeEntries(draft.ambiguities),
        outOfScope: Object.freeze([...draft.outOfScope]),
        acceptance: freezeEntries(draft.acceptance),
        decision: Object.freeze({ mode: config.mode, acceptedDefaults: Object.freeze(acceptedDefaults) }),
      });
      return complete(contract, 1);
    },
  });
}

function freezeEntries<T extends object>(entries: readonly T[]): readonly Readonly<T>[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}
