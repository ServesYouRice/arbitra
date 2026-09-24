import { createHash } from "node:crypto";
import { CHECKPOINT_DECISIONS, CHECKPOINT_ID_PATTERN, type CheckpointDecisionValue, type CheckpointPolicy } from "@arbitra/schemas/checkpoint-policy.js";
import { canonicalJson } from "../config/config-store.js";
import { RunCheckpointError } from "./suspension.js";
import type { NodeExecutionContext, NodeExecutor, RunnerGraph, RunnerNode } from "./workflow-runner.js";

/**
 * Generic `gate` and `human` node behavior, shared by every graph the runner executes.
 *
 * Neither kind has an implicit pass. A gate names a registered deterministic policy; an
 * unknown or missing policy fails. A human node resolves only from a persisted decision
 * for its current version: an operator response in interactive mode, or an explicit
 * operator-authored decision in the run policy in automatic mode.
 */

export interface GatePolicyResult { readonly passed: boolean; readonly reasons: readonly string[] }
export type GatePolicy = (context: NodeExecutionContext) => Promise<GatePolicyResult>;
export type GatePolicyRegistry = Readonly<Record<string, GatePolicy>>;

export interface HumanCheckpointRecord {
  readonly schemaVersion: 1;
  readonly checkpointId: string;
  readonly nodeId: string;
  /** Hash of the node definition and its inputs; a changed subject is a new version. */
  readonly version: string;
  readonly mode: CheckpointPolicy["mode"];
  readonly prompt: string;
  readonly decisions: readonly CheckpointDecisionValue[];
}

export interface CheckpointDecisionRecord {
  readonly checkpointId: string;
  readonly version: string;
  readonly decision: CheckpointDecisionValue;
  readonly decidedBy: "operator" | "run_policy";
}

export interface GateEvaluationRecord {
  readonly nodeId: string;
  readonly policy: string;
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

/** Durable storage. `decide` must be atomic create-once per checkpoint version. */
export interface GraphCheckpointStorePort {
  current(checkpointId: string): Promise<HumanCheckpointRecord | null>;
  open(record: HumanCheckpointRecord): Promise<void>;
  decision(checkpointId: string, version: string): Promise<CheckpointDecisionRecord | null>;
  /** Returns false, without writing, when a decision for that version already exists. */
  decide(record: CheckpointDecisionRecord): Promise<boolean>;
  recordGate(record: GateEvaluationRecord): Promise<void>;
  gateEvaluation(nodeId: string): Promise<GateEvaluationRecord | null>;
}

export type CheckpointStatus = "pending" | "approved" | "rejected";
export interface CheckpointView extends HumanCheckpointRecord {
  readonly kind: "human";
  readonly status: CheckpointStatus;
  readonly decidedBy?: CheckpointDecisionRecord["decidedBy"];
}

export class CheckpointResponseError extends Error {
  constructor(readonly code: "CHECKPOINT_NOT_FOUND" | "STALE_CHECKPOINT" | "CHECKPOINT_ALREADY_DECIDED" | "CHECKPOINT_NOT_INTERACTIVE", readonly statusCode: 404 | 409) {
    super(code);
    this.name = "CheckpointResponseError";
  }
}

/** An operator rejected a human checkpoint. The public gate reports it as a policy failure. */
export class CheckpointRejectedError extends Error {
  constructor(readonly checkpointId: string) { super(`CHECKPOINT_REJECTED:${checkpointId}`); this.name = "CheckpointRejectedError"; }
}

export class GateFailedError extends Error {
  constructor(readonly nodeId: string, readonly reasons: readonly string[]) { super(`GATE_FAILED:${nodeId}:${reasons.join(",")}`); this.name = "GateFailedError"; }
}

/**
 * Reject a graph whose gate/human nodes lack an explicit, known policy. Call it before a
 * run is created and again whenever a stored definition executes.
 */
export function validateGraphCheckpoints(graph: RunnerGraph, policy: CheckpointPolicy | undefined, gatePolicies: GatePolicyRegistry): void {
  const humans = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== "gate" && node.kind !== "human") continue;
    if (!CHECKPOINT_ID_PATTERN.test(node.id)) throw new Error(`INVALID_CHECKPOINT_NODE_ID:${node.id}`);
    if (node.kind === "gate") gatePolicyFor(node, gatePolicies);
    else {
      humans.add(node.id);
      humanPolicy(node, policy);
    }
  }
  for (const id of Object.keys(policy?.decisions ?? {})) if (!humans.has(id)) throw new Error(`UNKNOWN_CHECKPOINT_NODE:${id}`);
}

export class GraphCheckpoints {
  constructor(
    private readonly store: GraphCheckpointStorePort,
    private readonly policy: CheckpointPolicy | undefined,
    private readonly gatePolicies: GatePolicyRegistry,
  ) {}

  /** Executors for the runner. Graphs without these kinds never call them. */
  executors(): { readonly gate: NodeExecutor; readonly human: NodeExecutor } {
    return { gate: (context) => this.#gate(context), human: (context) => this.#human(context) };
  }

  /** The current version of every dispatched human node, in graph order. */
  async list(graph: RunnerGraph): Promise<readonly CheckpointView[]> {
    const views: CheckpointView[] = [];
    for (const node of graph.nodes) {
      if (node.kind !== "human") continue;
      const record = await this.store.current(node.id);
      if (record === null) continue;
      const decision = await this.store.decision(record.checkpointId, record.version);
      views.push(Object.freeze({ ...record, kind: "human" as const,
        status: decision === null ? "pending" as const : decision.decision === "approve" ? "approved" as const : "rejected" as const,
        ...(decision === null ? {} : { decidedBy: decision.decidedBy }) }));
    }
    return Object.freeze(views);
  }

  /** Reasons the public quality gate must report for this graph's gate/human nodes. */
  async gateReasons(graph: RunnerGraph): Promise<readonly string[]> {
    const reasons: string[] = [];
    for (const view of await this.list(graph)) {
      if (view.status === "pending") reasons.push(`checkpoint_pending:${view.checkpointId}`);
      if (view.status === "rejected") reasons.push(`checkpoint_rejected:${view.checkpointId}`);
    }
    for (const node of graph.nodes) {
      if (node.kind !== "gate") continue;
      const evaluation = await this.store.gateEvaluation(node.id);
      if (evaluation !== null && !evaluation.passed) reasons.push(`gate_failed:${node.id}`);
    }
    return Object.freeze(reasons);
  }

  /** Record one operator decision for the checkpoint's current version, exactly once. */
  async respond(checkpointId: string, version: string, decision: CheckpointDecisionValue): Promise<CheckpointDecisionRecord> {
    if (this.policy?.mode !== "interactive") throw new CheckpointResponseError("CHECKPOINT_NOT_INTERACTIVE", 409);
    if (!CHECKPOINT_DECISIONS.includes(decision)) throw new Error("INVALID_CHECKPOINT_DECISION");
    const current = await this.store.current(checkpointId);
    if (current === null) throw new CheckpointResponseError("CHECKPOINT_NOT_FOUND", 404);
    if (current.version !== version) throw new CheckpointResponseError("STALE_CHECKPOINT", 409);
    const record = Object.freeze({ checkpointId, version, decision, decidedBy: "operator" as const });
    if (!await this.store.decide(record)) throw new CheckpointResponseError("CHECKPOINT_ALREADY_DECIDED", 409);
    return record;
  }

  async #gate(context: NodeExecutionContext): Promise<unknown> {
    const { id, policy } = gatePolicyFor(context.node, this.gatePolicies);
    const result = await policy(context);
    if (typeof result?.passed !== "boolean" || !Array.isArray(result.reasons)) throw new Error(`INVALID_GATE_POLICY_RESULT:${id}`);
    // A failed policy with no stated reason still fails, and says so.
    const reasons = Object.freeze(result.passed ? [...result.reasons] : result.reasons.length === 0 ? ["gate_policy_failed"] : [...result.reasons]);
    await this.store.recordGate(Object.freeze({ nodeId: context.node.id, policy: id, passed: result.passed, reasons }));
    if (!result.passed) throw new GateFailedError(context.node.id, reasons);
    return Object.freeze({ gate: context.node.id, policy: id, passed: true, reasons });
  }

  async #human(context: NodeExecutionContext): Promise<unknown> {
    const { node } = context;
    const policy = humanPolicy(node, this.policy);
    const record: HumanCheckpointRecord = Object.freeze({
      schemaVersion: 1, checkpointId: node.id, nodeId: node.id, mode: policy.mode,
      version: checkpointVersion(node, context.inputs),
      prompt: promptFor(node), decisions: Object.freeze([...CHECKPOINT_DECISIONS]),
    });
    const current = await this.store.current(node.id);
    if (current === null || current.version !== record.version || current.mode !== record.mode) await this.store.open(record);
    if (policy.mode === "automatic") {
      const configured = policy.decisions[node.id];
      if (configured === undefined) throw new Error(`AUTOMATIC_CHECKPOINT_DECISION_REQUIRED:${node.id}`);
      await this.store.decide(Object.freeze({ checkpointId: node.id, version: record.version, decision: configured, decidedBy: "run_policy" }));
    }
    const decision = await this.store.decision(node.id, record.version);
    // No decision for the current version means the operator has not answered it yet.
    if (decision === null) throw new RunCheckpointError(`${node.id}:${record.version}`);
    if (decision.decision === "reject") throw new CheckpointRejectedError(node.id);
    return Object.freeze({ checkpointId: node.id, version: record.version, decision: decision.decision, decidedBy: decision.decidedBy });
  }
}

function gatePolicyFor(node: RunnerNode, registry: GatePolicyRegistry): { readonly id: string; readonly policy: GatePolicy } {
  const id = node.config?.["policy"];
  if (typeof id !== "string" || id.trim() === "") throw new Error(`GATE_POLICY_REQUIRED:${node.id}`);
  const policy = Object.hasOwn(registry, id) ? registry[id] : undefined;
  if (policy === undefined) throw new Error(`UNKNOWN_GATE_POLICY:${node.id}:${id}`);
  return { id, policy };
}

function humanPolicy(node: RunnerNode, policy: CheckpointPolicy | undefined): CheckpointPolicy {
  if (policy === undefined) throw new Error(`CHECKPOINT_POLICY_REQUIRED:${node.id}`);
  if (policy.mode === "automatic" && !Object.hasOwn(policy.decisions, node.id)) throw new Error(`AUTOMATIC_CHECKPOINT_DECISION_REQUIRED:${node.id}`);
  if (policy.mode !== "automatic" && policy.mode !== "interactive") throw new Error(`UNKNOWN_CHECKPOINT_POLICY:${String(policy.mode)}`);
  return policy;
}

function checkpointVersion(node: RunnerNode, inputs: ReadonlyMap<string, unknown>): string {
  const subject = { node, inputs: [...inputs.entries()].sort(([a], [b]) => a.localeCompare(b)) };
  return createHash("sha256").update(canonicalJson(subject)).digest("hex");
}

function promptFor(node: RunnerNode): string {
  const prompt = node.config?.["prompt"];
  return typeof prompt === "string" && prompt.trim() !== "" ? prompt : node.label;
}
