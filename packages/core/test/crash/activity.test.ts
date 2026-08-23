import { describe, expect, it } from "vitest";

import { ActivityRuntime, type ActivityArtifactRef, type ActivityRecord } from "../../src/activity.js";
import { activityId } from "../../src/activity-id.js";

const ref: ActivityArtifactRef = {
  hash: "a".repeat(64),
  byteLength: 11,
  extension: "json",
  relativePath: `artifacts/${"a".repeat(64)}.json`,
};

describe("activityId", () => {
  it("is stable across attempts and retry policy changes", () => {
    const first = activityId("run", "node", "model", { query: "x", config: { b: 2, a: 1 } });
    const afterAttemptAndRetryChanges = activityId(
      "run",
      "node",
      "model",
      { config: { a: 1, b: 2 }, query: "x" },
    );
    expect(afterAttemptAndRetryChanges).toBe(first);
  });

  it("includes prompt hash when present", () => {
    expect(activityId("run", "node", "model", {}, "prompt-a"))
      .not.toBe(activityId("run", "node", "model", {}, "prompt-b"));
  });
});

describe("ActivityRuntime crash semantics", () => {
  it("replays N completed activities without invoking their functions", async () => {
    const invoked: string[] = [];
    const journal = new RecordingJournal();
    const runtime = new ActivityRuntime({
      journal,
      artifacts: new MemoryArtifacts(new Map([[ref.hash, { value: 42 }]])),
      completed: new Map([["one", ref], ["two", ref]]),
    });
    expect(await runtime.activity("one", async () => { invoked.push("one"); return null; })).toEqual({ value: 42 });
    expect(await runtime.activity("two", async () => { invoked.push("two"); return null; })).toEqual({ value: 42 });
    expect(invoked).toEqual([]);
    expect(journal.records).toEqual([]);
  });

  it("re-executes an orphan attempt exactly once using the next attempt number", async () => {
    let invocations = 0;
    const journal = new RecordingJournal();
    const runtime = new ActivityRuntime({
      journal,
      artifacts: new MemoryArtifacts(),
      attempts: new Map([["orphan", 1]]),
    });
    expect(await runtime.activity("orphan", async () => { invocations += 1; return { ok: true }; })).toEqual({ ok: true });
    expect(invocations).toBe(1);
    expect(journal.records.map((record) => [record.t, record.attempt])).toEqual([
      ["attempt_start", 2],
      ["end", 2],
    ]);
  });

  it("makes the artifact durable before appending and fsyncing end", async () => {
    const events: string[] = [];
    const journal = new RecordingJournal(events);
    const artifacts = new MemoryArtifacts(undefined, events);
    const runtime = new ActivityRuntime({ journal, artifacts });
    await runtime.activity("ordered", async () => ({ result: true }));
    expect(events).toEqual([
      "journal:attempt_start:cheap",
      "artifact:write-and-fsync:expensive",
      "journal:end:expensive",
    ]);
  });

  it("re-runs a completion whose artifact is missing", async () => {
    let invocations = 0;
    const artifacts = new MemoryArtifacts();
    const runtime = new ActivityRuntime({
      journal: new RecordingJournal(),
      artifacts,
      completed: new Map([["missing", ref]]),
      attempts: new Map([["missing", 1]]),
    });
    await runtime.activity("missing", async () => { invocations += 1; return "replacement"; });
    expect(invocations).toBe(1);
  });

  it("records failures under the logical activity", async () => {
    const journal = new RecordingJournal();
    const runtime = new ActivityRuntime({ journal, artifacts: new MemoryArtifacts() });
    await expect(runtime.activity("failed", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(journal.records.map((record) => record.t)).toEqual(["attempt_start", "attempt_error"]);
  });
});

class RecordingJournal {
  readonly records: ActivityRecord[] = [];
  readonly #events: string[] | undefined;

  constructor(events?: string[]) { this.#events = events; }

  async append(record: ActivityRecord, durability: "cheap" | "expensive" = "cheap"): Promise<void> {
    this.records.push(record);
    this.#events?.push(`journal:${record.t}:${durability}`);
  }
}

class MemoryArtifacts {
  readonly #events: string[] | undefined;
  readonly #values: Map<string, unknown>;

  constructor(values = new Map<string, unknown>(), events?: string[]) {
    this.#values = values;
    this.#events = events;
  }

  async put(value: unknown, _extension: string, options?: { readonly durability?: "cheap" | "expensive" }): Promise<ActivityArtifactRef> {
    this.#events?.push(`artifact:write-and-fsync:${options?.durability ?? "expensive"}`);
    this.#values.set(ref.hash, value);
    return ref;
  }

  async get<T>(artifact: ActivityArtifactRef): Promise<T> {
    if (!this.#values.has(artifact.hash)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.#values.get(artifact.hash) as T;
  }
}
