import { appendFile, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { RunStore } from "../src/run-store.js";

// While `failingWrites` is above zero, each append to an event log fails: by default its write lands a prefix of the
// record and then fails, as a write to a full disk can; with `failing` set to "sync", the whole record lands and the
// sync after it fails.
const partial = vi.hoisted(() => ({ failingWrites: 0, failing: "write" as "write" | "sync" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (partial.failingWrites === 0 || !String(args[0]).endsWith("events.jsonl")) return handle;
    partial.failingWrites -= 1;
    const failing = partial.failing;
    const writeFile = async (data: string): Promise<void> => {
      if (failing === "sync") return handle.writeFile(data);
      await handle.writeFile(data.slice(0, 12));
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };
    const sync = async (): Promise<void> => {
      if (failing === "sync") throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return handle.sync();
    };
    return { writeFile, sync, stat: () => handle.stat(), close: () => handle.close() } as unknown as typeof handle;
  }) as typeof actual.open;
  return { ...actual, open };
});

describe("run store paths", () => {
  it("trims what a failed event append left before the next event is recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbitra-run-partial-"));
    try {
      const store = new RunStore(directory, "run-partial");
      await store.appendEvent({ t: "run_transition", runId: store.runId, state: "CREATED" });
      partial.failingWrites = 1;
      await expect(store.appendEvent({ t: "run_transition", runId: store.runId, state: "DISCOVERY_RUNNING" })).rejects.toThrow("ENOSPC");
      await store.appendEvent({ t: "run_transition", runId: store.runId, state: "CANCELLED" });
      expect((await store.loadEvents()).map((event) => event.t === "run_transition" ? event.state : event.t)).toEqual(["CREATED", "CANCELLED"]);
    } finally { partial.failingWrites = 0; await rm(directory, { recursive: true, force: true }); }
  });
  it("records an event once when its append is retried after the record was written whole and its sync failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbitra-run-sync-"));
    try {
      const store = new RunStore(directory, "run-sync");
      await store.appendEvent({ t: "run_transition", runId: store.runId, state: "CREATED" });
      partial.failing = "sync"; partial.failingWrites = 1;
      const event = { t: "run_transition", runId: store.runId, state: "DISCOVERY_RUNNING", at: "2026-10-25T12:00:00.000Z" } as const;
      await expect(store.appendEvent(event, "expensive")).rejects.toThrow("EIO");
      // The failed append left nothing behind for a reader, and the retry records the event once.
      expect(await store.loadEvents()).toHaveLength(1);
      await store.appendEvent(event, "expensive");
      expect((await store.loadEvents()).map((recorded) => recorded.t === "run_transition" ? recorded.state : recorded.t)).toEqual(["CREATED", "DISCOVERY_RUNNING"]);
    } finally { partial.failingWrites = 0; partial.failing = "write"; await rm(directory, { recursive: true, force: true }); }
  });
  it("recovers an incomplete event tail and redacts artifacts before writing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbitra-run-durable-"));
    try {
      const store = new RunStore(directory, "run-durable");
      await store.appendEvent({ t: "run_transition", runId: store.runId, state: "CREATED" });
      await appendFile(join(store.directory, "events.jsonl"), '{"t":"run_');
      expect(await store.loadEvents()).toHaveLength(1);
      const resumed = new RunStore(directory, store.runId);
      await resumed.appendEvent({ t: "run_transition", runId: store.runId, state: "CANCELLED" });
      expect(await resumed.loadEvents()).toHaveLength(2);
      const secret = "sk-abcdefghijklmnop";
      const artifact = await resumed.publish("evidence", { excerpt: `const apiKey = '${secret}';` });
      const persisted = await readFile(join(resumed.directory, artifact.ref.relativePath), "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).toContain("[REDACTED:");
      // A value filed under a secret's name is redacted, and JSON nested in a string survives redaction (observed
      // live: a stored prompt whose nested source line ended in an assignment no longer parsed).
      const nested = JSON.stringify({ lines: [{ line: 1, text: "    apiKey: gw7KeyForTheGateway," }, { line: 2, text: "    clock," }] });
      const stored = await resumed.publish("harness", { password: "arbitrary-long-secret", text: JSON.stringify({ layer: "round", value: nested }) });
      const read = JSON.parse((await resumed.readArtifact(stored.artifactId)).content) as { password: string; text: string };
      expect(read.password).toBe("[REDACTED:assigned_secret]");
      expect((JSON.parse((JSON.parse(read.text) as { value: string }).value) as { lines: { text: string }[] }).lines.map(({ text }) => text)).toEqual(["    apiKey: [REDACTED:assigned_secret],", "    clock,"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(["../outside", "..\\outside", "/absolute", "C:\\absolute", ".hidden", "run/id", ""])(
    "rejects an unsafe run id before constructing state paths: %s",
    (runId) => {
      expect(() => new RunStore("state", runId)).toThrow("INVALID_RUN_ID");
    },
  );

  it("accepts the generated run-id shape", () => {
    expect(new RunStore("state", "run-1234_abcd.test").runId).toBe("run-1234_abcd.test");
  });

  it("round-trips and validates the repository and consensus context needed for resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbitra-run-store-"));
    try {
      const store = new RunStore(directory, "run-context");
      const context = { repository: directory, repositoryDigest: "a".repeat(64), scope: { kind: "repository" as const }, consensusPolicy: "minimal" as const, maximumRounds: 1, criticEnabled: false };
      const before = Date.now();
      await store.saveContext(context);
      await expect(store.loadContext()).resolves.toEqual(context);
      await expect(store.saveContext({ ...context, maximumRounds: -1 })).rejects.toThrow("INVALID_RUN_CONTEXT_ROUNDS");
      // The creation time is recorded, so a copied run keeps it when its files take the copy's modification time.
      const created = (await store.times()).createdAt;
      expect(Date.parse(created ?? "")).toBeGreaterThanOrEqual(before - 1_000);
      await utimes(join(store.directory, "context.json"), new Date("2030-01-01"), new Date("2030-01-01"));
      expect((await store.times()).createdAt).toBe(created);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
