import { activityId } from "../activity-id.js";
import { ActivityRuntime, type ActivityArtifactStorePort } from "../activity.js";
import { RunCancellation } from "./cancellation.js";
import type { RunEvent, RunnerJournalPort, RunnerJournalRecord, RunState } from "./events.js";
import { projectRunState, projectRunner } from "./state-projection.js";

export const DEFAULT_CONCURRENCY_LIMIT = 4;

type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface RunnerNode {
  readonly id: string;
  readonly kind: "deterministic" | "model" | "gate" | "loop" | "human" | "subgraph";
  readonly label: string;
  readonly goal: unknown;
  readonly config?: Readonly<Record<string, JsonValue>>;
  readonly maximum?: number;
  readonly purpose?: string;
}

export interface RunnerEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface RunnerGraph {
  readonly schemaVersion: number;
  readonly id: string;
  readonly entryNodeId: string;
  readonly nodes: readonly RunnerNode[];
  readonly edges: readonly RunnerEdge[];
}

export interface RunnerConfig {
  readonly runId: string;
  readonly concurrencyLimit?: number;
}

export interface StoredRunDefinition {
  readonly graph: RunnerGraph;
  readonly config: { readonly runId: string; readonly concurrencyLimit: number };
}

export interface RunDefinitionStore {
  save(runId: string, definition: StoredRunDefinition): Promise<void>;
  load(runId: string): Promise<StoredRunDefinition>;
}

export interface NodeExecutionContext {
  readonly runId: string;
  readonly node: RunnerNode;
  readonly inputs: ReadonlyMap<string, unknown>;
  readonly signal: AbortSignal;
}

export type NodeExecutor = (context: NodeExecutionContext) => Promise<unknown>;

export interface WorkflowRunnerOptions {
  readonly journal: RunnerJournalPort;
  readonly artifacts: ActivityArtifactStorePort;
  readonly definitions: RunDefinitionStore;
  readonly loadRecords: (runId: string) => Promise<readonly RunnerJournalRecord[]>;
  readonly executors: Readonly<Partial<Record<RunnerNode["kind"], NodeExecutor>>>;
}

export interface ResumePlanEntry {
  readonly nodeId: string;
  readonly activityId: string;
  readonly action: "execute" | "replay";
}

export interface RunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<RunEvent>;
  readonly result: Promise<RunState>;
  readonly state: RunState;
  cancel(reason?: string): void;
}

export class WorkflowRunner {
  readonly #options: WorkflowRunnerOptions;

  constructor(options: WorkflowRunnerOptions) {
    this.#options = options;
  }

  start(graph: RunnerGraph, config: RunnerConfig): RunHandle {
    const definition = normaliseDefinition(graph, config);
    return this.#createHandle(config.runId, async () => {
      await this.#options.definitions.save(config.runId, definition);
      const records = [...await this.#options.loadRecords(config.runId)];
      return { definition, records, resumed: false };
    });
  }

  resume(runId: string): RunHandle {
    return this.#createHandle(runId, async () => ({
      definition: await this.#options.definitions.load(runId),
      records: [...await this.#options.loadRecords(runId)],
      resumed: true,
    }));
  }

  async planResume(runId: string): Promise<readonly ResumePlanEntry[]> {
    const definition = await this.#options.definitions.load(runId);
    const records = await this.#options.loadRecords(runId);
    const graphPlan = buildGraphPlan(definition.graph, runId);
    const completed = projectRunner(records).completed;
    return graphPlan.order.map((nodeId) => {
      const id = required(graphPlan.activityIds.get(nodeId), `Missing activity id for ${nodeId}`);
      return { nodeId, activityId: id, action: completed.has(id) ? "replay" : "execute" };
    });
  }

  #createHandle(
    runId: string,
    initialise: () => Promise<{ definition: StoredRunDefinition; records: RunnerJournalRecord[]; resumed: boolean }>,
  ): RunHandle {
    const cancellation = new RunCancellation();
    const stream = new EventStream<RunEvent>();
    let liveState: RunState = "CREATED";
    const result = (async (): Promise<RunState> => {
      let records: RunnerJournalRecord[] = [];
      const append = async (record: RunnerJournalRecord, durability: "cheap" | "expensive" = "cheap"): Promise<void> => {
        await this.#options.journal.append(record, durability);
        records.push(record);
        if (record.t === "run_transition") liveState = projectRunState(records);
        if (record.t === "run_transition" || record.t === "node_dispatched" || record.t === "node_completed") {
          stream.emit(record);
        }
      };
      try {
        const initial = await initialise();
        records = initial.records;
        const transition: RunEvent = { t: "run_transition", runId, state: "CREATED", ...(initial.resumed ? { reason: "resumed" } : {}) };
        await append(transition, "expensive");
        await this.#execute(initial.definition, records, append, cancellation);
        const state: RunState = cancellation.cancelled ? "CANCELLED" : "COMPLETED";
        await append({ t: "run_transition", runId, state, ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }) }, "expensive");
        return state;
      } catch (error) {
        if (cancellation.cancelled) {
          await append({ t: "run_transition", runId, state: "CANCELLED", reason: cancellation.reason ?? "Cancelled" }, "expensive");
          return "CANCELLED";
        }
        await append({ t: "run_transition", runId, state: "FAILED", reason: describeError(error) }, "expensive");
        return "FAILED";
      } finally {
        stream.close();
      }
    })();

    return {
      runId,
      events: stream,
      result,
      get state(): RunState { return liveState; },
      cancel(reason?: string): void { cancellation.cancel(reason); },
    };
  }

  async #execute(
    definition: StoredRunDefinition,
    records: RunnerJournalRecord[],
    append: (record: RunnerJournalRecord, durability?: "cheap" | "expensive") => Promise<void>,
    cancellation: RunCancellation,
  ): Promise<void> {
    const { graph, config } = definition;
    const plan = buildGraphPlan(graph, config.runId);
    const projection = projectRunner(records);
    const runtime = new ActivityRuntime({
      journal: { append },
      artifacts: this.#options.artifacts,
      completed: projection.completed,
      attempts: projection.attempts,
    });
    const outputs = new Map<string, unknown>();
    const pending = new Set(plan.order);

    while (pending.size > 0 && !cancellation.cancelled) {
      const ready = plan.order.filter((nodeId) => pending.has(nodeId)
        && required(plan.predecessors.get(nodeId), `Missing predecessors for ${nodeId}`).every((id) => outputs.has(id)));
      if (ready.length === 0) throw new Error("Workflow cannot advance; reachable graph contains a cycle");
      const batch = ready.slice(0, config.concurrencyLimit);
      const settled = await Promise.allSettled(batch.map(async (nodeId) => {
        if (cancellation.cancelled) return;
        const node = required(plan.nodes.get(nodeId), `Unknown node ${nodeId}`);
        const id = required(plan.activityIds.get(nodeId), `Missing activity id for ${nodeId}`);
        const wasCompleted = projection.completed.has(id);
        await append({ t: "node_dispatched", runId: config.runId, nodeId, activityId: id });
        const inputs = new Map(required(plan.predecessors.get(nodeId), "Missing predecessors")
          .map((predecessor) => [predecessor, outputs.get(predecessor)] as const));
        const executor = this.#options.executors[node.kind];
        if (executor === undefined) throw new Error(`No executor registered for ${node.kind} node ${node.id}`);
        const output = await runtime.activity(id, async () => executor({ runId: config.runId, node, inputs, signal: cancellation.signal }));
        outputs.set(nodeId, output);
        pending.delete(nodeId);
        await append({ t: "node_completed", runId: config.runId, nodeId, activityId: id, replayed: wasCompleted });
      }));
      const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failure !== undefined && !cancellation.cancelled) throw failure.reason;
    }
  }
}

function normaliseDefinition(graph: RunnerGraph, config: RunnerConfig): StoredRunDefinition {
  const concurrencyLimit = config.concurrencyLimit ?? DEFAULT_CONCURRENCY_LIMIT;
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1) {
    throw new TypeError("concurrencyLimit must be a positive safe integer");
  }
  return { graph, config: { runId: config.runId, concurrencyLimit } };
}

function buildGraphPlan(graph: RunnerGraph, runId: string): {
  order: string[];
  nodes: ReadonlyMap<string, RunnerNode>;
  predecessors: ReadonlyMap<string, readonly string[]>;
  activityIds: ReadonlyMap<string, string>;
} {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!nodes.has(graph.entryNodeId)) throw new Error(`Unknown entry node ${graph.entryNodeId}`);
  const outgoing = new Map<string, RunnerEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const order: string[] = [];
  const reachable = new Set<string>();
  const queue = [graph.entryNodeId];
  while (queue.length > 0) {
    const nodeId = required(queue.shift(), "Queue unexpectedly empty");
    if (reachable.has(nodeId)) continue;
    if (!nodes.has(nodeId)) throw new Error(`Edge targets unknown node ${nodeId}`);
    reachable.add(nodeId);
    order.push(nodeId);
    for (const edge of [...(outgoing.get(nodeId) ?? [])].sort((a, b) => a.id.localeCompare(b.id))) queue.push(edge.to);
  }
  const predecessors = new Map(order.map((nodeId) => [nodeId, [] as string[]]));
  const incomingEdges = new Map(order.map((nodeId) => [nodeId, [] as RunnerEdge[]]));
  for (const edge of graph.edges) {
    if (reachable.has(edge.from) && reachable.has(edge.to)) {
      required(predecessors.get(edge.to), "Missing predecessor list").push(edge.from);
      required(incomingEdges.get(edge.to), "Missing incoming edge list").push(edge);
    }
  }
  const activityIds = new Map<string, string>();
  const visiting = new Set<string>();
  const identify = (nodeId: string): string => {
    const existing = activityIds.get(nodeId);
    if (existing !== undefined) return existing;
    if (visiting.has(nodeId)) throw new Error("Reachable workflow graph contains a cycle");
    visiting.add(nodeId);
    const node = required(nodes.get(nodeId), `Unknown node ${nodeId}`);
    const edges = [...required(incomingEdges.get(nodeId), "Missing incoming edges")].sort((a, b) => a.id.localeCompare(b.id));
    const id = activityId(runId, nodeId, "workflow_node", {
      graphSchemaVersion: graph.schemaVersion,
      node,
      incoming: edges.map((edge) => ({ edge, activityId: identify(edge.from) })),
    });
    visiting.delete(nodeId);
    activityIds.set(nodeId, id);
    return id;
  };
  for (const nodeId of order) identify(nodeId);
  return { order, nodes, predecessors, activityIds };
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

class EventStream<T> implements AsyncIterable<T> {
  readonly #queue: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  emit(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#queue.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#queue.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
