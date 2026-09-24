import type { CheckpointDecisionRecord, GateEvaluationRecord, GraphCheckpointStorePort, HumanCheckpointRecord } from "@arbitra/core/runner/graph-checkpoints.js";
import { checkpointDecisionSchema } from "@arbitra/schemas/checkpoint-policy.js";
import type { RunStore } from "./run-store.js";

/**
 * Generic checkpoint state inside the run directory.
 *
 * Checkpoint versions and gate evaluations are published as named, content-addressed
 * artifacts, so status, export and the UI read the same records the runner used.
 * A decision is a create-once record per checkpoint version: a second response, from any
 * process, cannot replace the first. Its artifact copy is published for visibility only.
 */
export function graphCheckpointStore(store: RunStore): GraphCheckpointStorePort {
  const readNamed = async <T>(kind: string): Promise<T | null> => {
    const descriptor = (await store.listArtifacts()).find((item) => item.kind === kind);
    return descriptor === undefined ? null : store.artifacts.get<T>(descriptor.ref);
  };
  return {
    current: async (checkpointId) => {
      const record = await readNamed<HumanCheckpointRecord>(`checkpoint-${checkpointId}`);
      if (record !== null && (record.checkpointId !== checkpointId || !/^[a-f0-9]{64}$/u.test(record.version))) throw new Error(`INVALID_CHECKPOINT_RECORD:${checkpointId}`);
      return record;
    },
    open: async (record) => {
      await store.publish(`checkpoint-${record.checkpointId}-version-${record.version.slice(0, 16)}`, record, record.nodeId);
      await store.publish(`checkpoint-${record.checkpointId}`, record, record.nodeId);
    },
    decision: async (checkpointId, version) => {
      const record = await store.readOnce<CheckpointDecisionRecord>(["checkpoints", checkpointId, version]);
      if (record === null) return null;
      if (record.checkpointId !== checkpointId || record.version !== version || !checkpointDecisionSchema.safeParse(record.decision).success) throw new Error(`INVALID_CHECKPOINT_DECISION_RECORD:${checkpointId}`);
      return record;
    },
    decide: async (record) => {
      const created = await store.createOnce(["checkpoints", record.checkpointId, record.version], record);
      if (created) await store.publish(`checkpoint-${record.checkpointId}-decision-${record.version.slice(0, 16)}`, record, record.checkpointId);
      return created;
    },
    recordGate: async (record) => { await store.publish(`gate-evaluation-${record.nodeId}`, record, record.nodeId); },
    gateEvaluation: (nodeId) => readNamed<GateEvaluationRecord>(`gate-evaluation-${nodeId}`),
  };
}
