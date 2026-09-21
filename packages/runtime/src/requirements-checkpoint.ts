import { createHash } from "node:crypto";
import { RunCheckpointError } from "@arbitra/core/runner/suspension.js";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { requirementsContractSchema, requirementsDraftSchema, type RequirementsContract } from "@arbitra/schemas/requirements.js";
import { requirementsNode, type RequirementsNodeConfig, type RequirementsNodeInput } from "@arbitra/workflow/nodes/requirements/index.js";
import type { RunStore } from "./run-store.js";

/** Own one instance per active run; serialize approvals with draft creation. */
export class RequirementsCheckpoint {
  #pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: RunStore, private readonly config: Omit<RequirementsNodeConfig, "schema" | "artifacts">) {}

  open(input: RequirementsNodeInput) {
    const captured = structuredClone(input);
    const inputFingerprint = createHash("sha256").update(canonicalJson({ featureRequest: captured.featureRequest, repositorySummary: captured.repositorySummary, mode: this.config.mode })).digest("hex");
    return this.serial(async () => {
      if ((captured.operatorAcceptedDefaults?.length ?? 0) > 0) throw new Error("REQUIREMENTS_APPROVAL_REQUIRES_SAVED_CONTRACT");
      const previous = await this.current();
      if (previous !== null) {
        if (previous.inputFingerprint !== inputFingerprint) throw new Error("REQUIREMENTS_CHECKPOINT_INPUT_CHANGED");
        return previous;
      }
      await this.node(inputFingerprint).run(captured);
      return this.requiredCurrent();
    });
  }

  approve(artifactId: string, ambiguityIds: readonly string[]) {
    const capturedIds = [...ambiguityIds];
    return this.serial(async () => {
      const current = await this.requiredCurrent();
      if (current.artifactId !== artifactId) throw new Error("STALE_REQUIREMENTS_CHECKPOINT");
      await this.node(current.inputFingerprint, current.artifactId).resume({ artifactId, operatorAcceptedDefaults: capturedIds });
      return this.requiredCurrent();
    });
  }

  revise(artifactId: string, draft: unknown) {
    const captured = structuredClone(draft);
    return this.serial(async () => {
      const current = await this.requiredCurrent();
      if (current.artifactId !== artifactId) throw new Error("STALE_REQUIREMENTS_CHECKPOINT");
      const revised = requirementsDraftSchema.parse(captured);
      const { assumptions, ambiguities, acceptance, outOfScope } = current.contract;
      if (canonicalJson(revised) === canonicalJson({ assumptions, ambiguities, acceptance, outOfScope })) return current;
      const contract = requirementsContractSchema.parse({ schemaVersion: 1, featureRequest: current.contract.featureRequest, ...revised,
        decision: { mode: this.config.mode, acceptedDefaults: this.config.mode === "automatic" ? revised.ambiguities.map(({ id, proposedDefault }) => ({ ambiguityId: id, value: proposedDefault, acceptedBy: "automatic_mode" })) : [] },
      });
      // Approvals refer to the complete reviewed contract, not just an ID/value pair.
      // Any semantic draft change in interactive mode requires renewed decisions.
      await this.persistContract(contract, current.inputFingerprint, current.artifactId);
      return this.requiredCurrent();
    });
  }

  async requireResolved() {
    const current = await this.requiredCurrent();
    if (current.pendingAmbiguityIds.length > 0) throw new RunCheckpointError(current.artifactId);
    return current.contract;
  }

  async current() {
    const head = (await this.store.listArtifacts()).find(({ kind }) => kind === "requirements-checkpoint-head");
    if (head === undefined) return null;
    const pointer = await this.store.artifacts.get<{ artifactId: string; inputFingerprint: string; protocolVersion: string; protocolHash: string }>(head.ref);
    if (typeof pointer.inputFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(pointer.inputFingerprint)) throw new Error("INVALID_REQUIREMENTS_CHECKPOINT_IDENTITY");
    if (pointer.protocolVersion !== this.config.protocolVersion || pointer.protocolHash !== this.config.protocolHash) throw new Error("REQUIREMENTS_CHECKPOINT_PROTOCOL_CHANGED");
    const artifact = await this.store.readArtifact(pointer.artifactId);
    if (!artifact.descriptor.kind.startsWith("requirements-contract-version-")) throw new Error("INVALID_REQUIREMENTS_CHECKPOINT_ARTIFACT");
    const contract = requirementsContractSchema.parse(JSON.parse(artifact.content));
    if (contract.decision.mode !== this.config.mode) throw new Error("REQUIREMENTS_CHECKPOINT_MODE_CHANGED");
    const accepted = new Set(contract.decision.acceptedDefaults.map(({ ambiguityId }) => ambiguityId));
    return { artifactId: pointer.artifactId, inputFingerprint: pointer.inputFingerprint, contract, pendingAmbiguityIds: contract.decision.mode === "automatic" ? [] : contract.ambiguities.filter(({ id, blastRadius }) => blastRadius === "high" && !accepted.has(id)).map(({ id }) => id) };
  }

  private async requiredCurrent() {
    const current = await this.current();
    if (current === null) throw new Error("REQUIREMENTS_CHECKPOINT_ABSENT");
    return current;
  }

  private node(inputFingerprint: string, parentArtifactId: string | null = null) {
    return requirementsNode({ ...this.config, schema: requirementsDraftSchema, artifacts: {
      load: async (artifactId) => JSON.parse((await this.store.readArtifact(artifactId)).content) as unknown,
      persist: async (_kind, contract) => this.persistContract(requirementsContractSchema.parse(contract), inputFingerprint, parentArtifactId),
    } });
  }

  private async persistContract(contract: RequirementsContract, inputFingerprint: string, parentArtifactId: string | null) {
    const hash = createHash("sha256").update(canonicalJson({ contract, parentArtifactId })).digest("hex");
    const version = await this.store.publish(`requirements-contract-version-${hash}`, contract, "requirements");
    await this.store.publish(`requirements-contract-lineage-${hash}`, { artifactId: version.artifactId, parentArtifactId }, "requirements");
    await this.store.publish("requirements-checkpoint-head", { artifactId: version.artifactId, inputFingerprint, protocolVersion: this.config.protocolVersion, protocolHash: this.config.protocolHash }, "requirements");
    return { artifactId: version.artifactId };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(work);
    this.#pending = result.catch(() => undefined);
    return result;
  }
}
