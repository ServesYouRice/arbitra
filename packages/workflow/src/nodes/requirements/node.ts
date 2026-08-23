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
  return Object.freeze({
    async run(input: RequirementsNodeInput) {
      if (input.featureRequest.trim() === "") throw new Error("FEATURE_REQUEST_REQUIRED");
      const draft = config.schema.parse(await config.runtime.generate(Object.freeze({
        featureRequest: input.featureRequest,
        repositorySummary: input.repositorySummary,
        protocol: Object.freeze({ protocolId: "feature-requirements" as const, protocolVersion: config.protocolVersion, protocolHash: config.protocolHash }),
        capability: "balanced" as const,
        outputSchema: "RequirementsContractDraft" as const,
      })));
      validateDraft(draft);
      const operatorAccepted = new Set(input.operatorAcceptedDefaults ?? []);
      const acceptedDefaults = draft.ambiguities
        .filter((ambiguity) => config.mode === "automatic" || operatorAccepted.has(ambiguity.id))
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
      const artifact = await config.artifacts.persist("requirements-contract", contract);
      const checkpoint = config.mode === "interactive"
        ? draft.ambiguities.filter(({ blastRadius, id }) => blastRadius === "high" && !operatorAccepted.has(id))
        : [];
      return Object.freeze({
        contract,
        artifact,
        modelCalls: 1 as const,
        checkpoint: checkpoint.length === 0 ? null : Object.freeze({
          kind: "high_impact_ambiguities" as const,
          ambiguityIds: Object.freeze(checkpoint.map(({ id }) => id)),
        }),
      });
    },
  });
}

function validateDraft(draft: RequirementsModelOutput): void {
  if (draft.assumptions.length === 0 || draft.acceptance.length === 0) throw new Error("INCOMPLETE_REQUIREMENTS_CONTRACT");
  const ids = [...draft.assumptions, ...draft.ambiguities, ...draft.acceptance].map(({ id }) => id);
  if (ids.some((id) => id.trim() === "") || new Set(ids).size !== ids.length) throw new Error("INVALID_REQUIREMENTS_IDENTIFIERS");
  for (const ambiguity of draft.ambiguities) if (ambiguity.proposedDefault.trim() === "") throw new Error(`MISSING_PROPOSED_DEFAULT:${ambiguity.id}`);
}

function freezeEntries<T extends object>(entries: readonly T[]): readonly Readonly<T>[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

