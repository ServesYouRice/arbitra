export const CHECKPOINT_STAGES = ["after_discovery", "after_consensus", "after_verification", "before_planning", "before_final_compilation"] as const;
export type CheckpointStage = typeof CHECKPOINT_STAGES[number];
export interface PendingCheckpoint { readonly id: string; readonly stage: CheckpointStage; readonly status: "pending"; readonly prompt: string }

export class CheckpointRegistry {
  readonly #pending = new Map<string, { checkpoint: PendingCheckpoint; resolve: (decision: string) => void }>();
  async wait(runId: string, mode: "automatic" | "interactive", checkpoint: Omit<PendingCheckpoint, "status">): Promise<string | null> {
    if (mode === "automatic") return null;
    if (!CHECKPOINT_STAGES.includes(checkpoint.stage)) throw new Error("INVALID_CHECKPOINT_STAGE");
    const key = `${runId}:${checkpoint.id}`;
    return new Promise((resolve) => this.#pending.set(key, { checkpoint: Object.freeze({ ...checkpoint, status: "pending" }), resolve }));
  }
  list(runId: string): readonly PendingCheckpoint[] { return Object.freeze([...this.#pending.entries()].filter(([key]) => key.startsWith(`${runId}:`)).map(([, value]) => value.checkpoint)); }
  respond(runId: string, checkpointId: string, decision: string): void { const key = `${runId}:${checkpointId}`; const pending = this.#pending.get(key); if (pending === undefined) throw new Error("CHECKPOINT_NOT_FOUND"); if (decision.trim() === "") throw new Error("CHECKPOINT_DECISION_REQUIRED"); this.#pending.delete(key); pending.resolve(decision); }
}

