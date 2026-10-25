import { mkdir, mkdtemp, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadJournal, projectJournal } from "../src/journal-load.js";
import { ActivityJournal, type JournalFileSystem, type JournalRecord } from "../src/journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("ActivityJournal", () => {
  it("writes before fsync and resolves only after close", async () => {
    const events: string[] = [];
    const fileSystem: JournalFileSystem = {
      async mkdir() { events.push("mkdir"); },
      async open() {
        events.push("open");
        return {
          async write() { events.push("write"); },
          async stat() { return { size: 0 }; },
          async sync() { events.push("fsync"); },
          async close() { events.push("close"); },
        };
      },
      async truncate() { events.push("truncate"); },
    };
    const journal = new ActivityJournal("run/journal.jsonl", { fileSystem, fsyncPolicy: "always" });
    await journal.append({ t: "attempt_start", id: "a", attempt: 1 }, "expensive");
    expect(events).toEqual(["mkdir", "open", "write", "fsync", "close"]);
  });

  it.each(["write", "sync"] as const)("leaves nothing of an append whose %s fails, so a retry records it once", async (failing) => {
    // A write that fails partway leaves a prefix of the record, and a sync that fails leaves all of it.
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.jsonl");
    let fail = true;
    const fileSystem: JournalFileSystem = {
      mkdir: (target, options) => mkdir(target, options),
      async open(target, flags) {
        const handle = await open(target, flags);
        return {
          async write(data) { if (!fail || failing !== "write") return handle.write(data); await handle.write(data.subarray(0, 12)); throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); },
          async sync() { if (fail && failing === "sync") throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); await handle.sync(); },
          stat: () => handle.stat(), close: () => handle.close(),
        };
      },
      truncate: (target, length) => truncate(target, length),
    };
    const journal = new ActivityJournal(path, { fileSystem, fsyncPolicy: "always" });
    const record: JournalRecord = { t: "attempt_start", id: "a", attempt: 1 };
    await expect(journal.append(record)).rejects.toThrow(failing === "write" ? "ENOSPC" : "EIO");
    fail = false;
    await journal.append(record);
    expect(await loadJournal(path)).toEqual({ records: [record], truncatedBytes: 0 });
  });
});

describe("loadJournal", () => {
  it("loads every record type and projects attempts and completions", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.jsonl");
    const artifact = { hash: "a".repeat(64), byteLength: 2, extension: "json", relativePath: `artifacts/${"a".repeat(64)}.json` };
    const records: JournalRecord[] = [
      { t: "attempt_start", id: "a", attempt: 1, providerRequestId: "provider-1" },
      { t: "attempt_error", id: "a", attempt: 1, error: "timeout" },
      { t: "attempt_start", id: "a", attempt: 2 },
      {
        t: "end",
        id: "a",
        attempt: 2,
        ok: true,
        artifact,
        usage: null,
      },
    ];
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const loaded = await loadJournal(path);
    expect(loaded).toEqual({ records, truncatedBytes: 0 });
    const projection = projectJournal(loaded.records);
    expect(projection.attempts.get("a")).toBe(2);
    expect(projection.completed.get("a")).toEqual(artifact);
  });

  it("truncates a torn final line and reports the recovered byte count", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.jsonl");
    const complete = `${JSON.stringify({ t: "attempt_start", id: "a", attempt: 1 })}\n`;
    const torn = '{"t":"end","id":"a"';
    await writeFile(path, complete + torn);
    const loaded = await loadJournal(path);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.truncatedBytes).toBe(Buffer.byteLength(torn));
    expect((await readFile(path, "utf8"))).toBe(complete);
  });

  it("does not disguise corruption in a complete line as a torn append", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "journal.jsonl");
    await writeFile(path, "not-json\n");
    await expect(loadJournal(path)).rejects.toThrow("complete line 1");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arbitra-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}
