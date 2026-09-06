import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RunStore } from "../src/run-store.js";

describe("run store paths", () => {
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
      await store.saveContext(context);
      await expect(store.loadContext()).resolves.toEqual(context);
      await expect(store.saveContext({ ...context, maximumRounds: -1 })).rejects.toThrow("INVALID_RUN_CONTEXT_ROUNDS");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
