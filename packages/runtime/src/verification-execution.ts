import { createHash } from "node:crypto";
import { canonicalJson } from "@arbitra/core/config/config-store.js";
import { verificationExecutionSchema, type VerificationExecution } from "@arbitra/schemas/verification-execution.js";
import type { RepositorySnapshot } from "./repository.js";
import { RunStore } from "./run-store.js";
import { DockerTestSandbox, type SandboxRecoveryHandle, type SandboxTestResult, type TestSandbox } from "./test-sandbox.js";

export interface VerificationExecutionRecord {
  readonly id: string;
  readonly checkId: string;
  readonly state: "reserved" | "prepared" | "completed" | "interrupted";
  readonly handle?: SandboxRecoveryHandle;
  readonly result?: SandboxTestResult;
  readonly invocationId?: string;
  readonly snapshotFingerprint?: string;
  readonly executionFingerprint?: string;
}

/** One coordinator per run. Reservations commit before dispatch and never refund budget. */
export class VerificationExecutor {
  #pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: RunStore, private readonly sandbox: TestSandbox = new DockerTestSandbox()) {}

  execute(snapshot: RepositorySnapshot, policy: VerificationExecution, sourcePaths: readonly string[], signal: AbortSignal, invocationId?: string): Promise<{ records: readonly VerificationExecutionRecord[]; deferredCheckIds: readonly string[] }> {
    if (invocationId !== undefined && (invocationId.trim() === "" || invocationId.length > 200)) return Promise.reject(new Error("INVALID_VERIFICATION_INVOCATION_ID"));
    const work = this.#pending.then(() => this.executeSerial(snapshot, policy, sourcePaths, signal, invocationId));
    this.#pending = work.catch(() => undefined);
    return work;
  }

  private async executeSerial(snapshot: RepositorySnapshot, policy: VerificationExecution, sourcePaths: readonly string[], signal: AbortSignal, invocationId?: string) {
    const execution = verificationExecutionSchema.parse(policy);
    const descriptors = (await this.store.listArtifacts()).filter(({ kind }) => kind.startsWith("verification-execution-"));
    const saved = await Promise.all(descriptors.map(({ ref }) => this.store.artifacts.get<VerificationExecutionRecord>(ref)));
    // Recover all unfinished resources before making another dispatch, even if the
    // next candidate or configuration no longer selects the original check.
    for (let index = 0; index < saved.length; index += 1) {
      const record = saved[index];
      if (record === undefined || record.state === "completed" || record.state === "interrupted") continue;
      if (record.handle !== undefined) await this.sandbox.recover(record.handle);
      const recovered: VerificationExecutionRecord = { ...record, state: "interrupted" };
      await this.publish(recovered); saved[index] = recovered;
    }
    const records: VerificationExecutionRecord[] = []; const deferredCheckIds: string[] = [];
    const paths = new Set(sourcePaths);
    const digest = createHash("sha256").update(JSON.stringify(snapshot.files.map(({ path, lines }) => ({ path, lines })))).digest("hex");
    for (const check of execution.checks.filter(({ sourcePaths: selected }) => selected.some((path) => paths.has(path)))) {
      if (signal.aborted) throw new Error("VERIFICATION_CANCELLED");
      const id = createHash("sha256").update(JSON.stringify({ digest, execution, check, ...(invocationId === undefined ? {} : { invocationId }) })).digest("hex");
      const previous = saved.find((record) => record.id === id);
      if (previous !== undefined) { records.push(previous); continue; }
      if (saved.length >= execution.maximumRuns) { deferredCheckIds.push(check.id); continue; }
      let record: VerificationExecutionRecord = { id, checkId: check.id, state: "reserved", ...(invocationId === undefined ? {} : {
        invocationId, snapshotFingerprint: verificationSnapshotFingerprint(snapshot), executionFingerprint: createHash("sha256").update(canonicalJson(execution)).digest("hex"),
      }) };
      await this.publish(record); saved.push(record);
      const result = await this.sandbox.run(snapshot, execution, check, signal, { prepared: async (handle) => {
        record = { ...record, state: "prepared", handle };
        await this.publish(record);
      } });
      record = { ...record, state: "completed", result };
      await this.publish(record);
      // Read back the redacted artifact before returning tool output to a model.
      const descriptor = (await this.store.listArtifacts()).find(({ kind }) => kind === `verification-execution-${id}`);
      if (descriptor === undefined) throw new Error("VERIFICATION_EXECUTION_ARTIFACT_ABSENT");
      records.push(await this.store.artifacts.get<VerificationExecutionRecord>(descriptor.ref));
    }
    return { records, deferredCheckIds };
  }

  private async publish(record: VerificationExecutionRecord): Promise<void> {
    await this.store.publish(`verification-execution-${record.id}`, record, "verification");
  }
}

export function verificationSnapshotFingerprint(snapshot: RepositorySnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot.files.map(({ path, lines }) => ({ path, lines })).sort((a, b) => a.path.localeCompare(b.path)))).digest("hex");
}
