import { appendFile, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
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
      // A value filed under a secret's name is redacted, and JSON nested in a string survives redaction (observed
      // live: a stored prompt whose nested source line ended in an assignment no longer parsed).
      const nested = JSON.stringify({ lines: [{ line: 1, text: "    apiKey: gw7KeyForTheGateway," }, { line: 2, text: "    clock," }] });
      const stored = await resumed.publish("harness", { password: "arbitrary-long-secret", text: JSON.stringify({ layer: "round", value: nested }) });
      const read = JSON.parse((await resumed.readArtifact(stored.artifactId)).content) as { password: string; text: string };
      expect(read.password).toBe("[REDACTED:assigned_secret]");
      expect((JSON.parse((JSON.parse(read.text) as { value: string }).value) as { lines: { text: string }[] }).lines.map(({ text }) => text)).toEqual(["    apiKey: [REDACTED:assigned_secret]", "    clock,"]);
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
