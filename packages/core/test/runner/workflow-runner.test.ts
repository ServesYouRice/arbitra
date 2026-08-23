import { describe, expect, it } from "vitest";

import type { ActivityArtifactRef } from "../../src/activity.js";
import type { RunnerJournalRecord } from "../../src/runner/events.js";
import { projectRunState, projectRunner } from "../../src/runner/state-projection.js";
import {
  WorkflowRunner,
  type NodeExecutor,
  type RunnerGraph,
  type StoredRunDefinition,
} from "../../src/runner/workflow-runner.js";

describe("WorkflowRunner", () => {
  it("resumes a five-node fan-out after three durable completions and runs only two bodies", async () => {
    const storage = new MemoryRuntimeStorage();
    const firstInvocations: string[] = [];
    let successfulBodies = 0;
    const first = createRunner(storage, async ({ node }) => {
      firstInvocations.push(node.id);
      if (successfulBodies === 3) throw new Error("synthetic process death");
      successfulBodies += 1;
      return { nodeId: node.id };
    });

    const failed = first.start(fiveNodeFanOut(), { runId: "resume-run", concurrencyLimit: 1 });
    expect(await failed.result).toBe("FAILED");
    expect(projectRunner(storage.records).completed.size).toBe(3);

    const resumedInvocations: string[] = [];
    const resumed = createRunner(storage, async ({ node }) => {
      resumedInvocations.push(node.id);
      return { nodeId: node.id };
    }).resume("resume-run");
    expect(await resumed.result).toBe("COMPLETED");
    expect(resumedInvocations).toHaveLength(2);
    expect(new Set([...firstInvocations.slice(0, 3), ...resumedInvocations])).toEqual(
      new Set(["entry", "a", "b", "c", "d"]),
    );
    expect(projectRunState(storage.records)).toBe(resumed.state);
  });

  it("emits every node and run transition and obeys the configured concurrency limit", async () => {
    const storage = new MemoryRuntimeStorage();
    let active = 0;
    let maximumActive = 0;
    const runner = createRunner(storage, async ({ node }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return node.id;
    });
    const handle = runner.start(fiveNodeFanOut(), { runId: "events-run", concurrencyLimit: 2 });
    const eventsPromise = collect(handle.events);
    expect(await handle.result).toBe("COMPLETED");
    const events = await eventsPromise;
    expect(maximumActive).toBe(2);
    expect(events.filter((event) => event.t === "node_dispatched")).toHaveLength(5);
    expect(events.filter((event) => event.t === "node_completed")).toHaveLength(5);
    expect(events.filter((event) => event.t === "run_transition").map((event) => event.state))
      .toEqual(["CREATED", "COMPLETED"]);
    expect(projectRunState(storage.records)).toBe(handle.state);
  });

  it("cancels active fan-out, preserves completions, and remains resumable", async () => {
    const storage = new MemoryRuntimeStorage();
    let releaseBlocked: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    const runner = createRunner(storage, async ({ node, signal }) => {
      if (node.id === "entry" || node.id === "a") return node.id;
      await Promise.race([
        blocked,
        new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      ]);
      return node.id;
    });
    const handle = runner.start(fiveNodeFanOut(), { runId: "cancel-run", concurrencyLimit: 2 });
    for await (const event of handle.events) {
      if (event.t === "node_completed" && event.nodeId === "a") {
        handle.cancel("operator request");
        break;
      }
    }
    expect(await handle.result).toBe("CANCELLED");
    expect(projectRunState(storage.records)).toBe("CANCELLED");
    const completedBeforeResume = projectRunner(storage.records).completed.size;
    expect(completedBeforeResume).toBe(2);

    releaseBlocked?.();
    const resumedInvocations: string[] = [];
    const resumedRunner = createRunner(storage, async ({ node }) => {
      resumedInvocations.push(node.id);
      return node.id;
    });
    expect((await resumedRunner.planResume("cancel-run")).filter(({ action }) => action === "replay")).toHaveLength(2);
    expect(await resumedRunner.resume("cancel-run").result).toBe("COMPLETED");
    expect(resumedInvocations).toHaveLength(3);
    expect(storage.artifacts.values.size).toBe(5);
  });

  it("rejects invalid concurrency explicitly", () => {
    const storage = new MemoryRuntimeStorage();
    const runner = createRunner(storage, async () => null);
    expect(() => runner.start(fiveNodeFanOut(), { runId: "invalid", concurrencyLimit: 0 }))
      .toThrow("concurrencyLimit");
  });
});

function createRunner(
  storage: MemoryRuntimeStorage,
  execute: NodeExecutor,
): WorkflowRunner {
  return new WorkflowRunner({
    journal: storage,
    artifacts: storage.artifacts,
    definitions: storage,
    loadRecords: async () => [...storage.records],
    executors: { deterministic: execute, gate: execute },
  });
}

function fiveNodeFanOut(): RunnerGraph {
  const goal = { objective: "test", doneWhen: [], stopWhen: [], blockedWhen: [] };
  const node = (id: string) => ({ id, kind: "deterministic" as const, label: id, goal });
  return {
    schemaVersion: 1,
    id: "fan-out",
    entryNodeId: "entry",
    nodes: [{ ...node("entry"), kind: "gate" }, node("a"), node("b"), node("c"), node("d")],
    edges: ["a", "b", "c", "d"].map((to) => ({ id: `entry-${to}`, from: "entry", to })),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

class MemoryRuntimeStorage {
  readonly records: RunnerJournalRecord[] = [];
  readonly artifacts = new MemoryArtifacts();
  readonly #definitions = new Map<string, StoredRunDefinition>();

  async append(record: RunnerJournalRecord): Promise<void> {
    this.records.push(record);
  }

  async save(runId: string, definition: StoredRunDefinition): Promise<void> {
    this.#definitions.set(runId, definition);
  }

  async load(runId: string): Promise<StoredRunDefinition> {
    const definition = this.#definitions.get(runId);
    if (definition === undefined) throw new Error(`Missing definition ${runId}`);
    return definition;
  }
}

class MemoryArtifacts {
  readonly values = new Map<string, unknown>();
  #next = 0;

  async put(value: unknown, extension: string): Promise<ActivityArtifactRef> {
    this.#next += 1;
    const hash = this.#next.toString(16).padStart(64, "0");
    this.values.set(hash, value);
    return { hash, byteLength: JSON.stringify(value).length, extension, relativePath: `artifacts/${hash}.${extension}` };
  }

  async get<T>(ref: ActivityArtifactRef): Promise<T> {
    if (!this.values.has(ref.hash)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.values.get(ref.hash) as T;
  }
}
