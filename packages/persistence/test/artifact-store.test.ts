import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStore,
  type ArtifactFileHandle,
  type ArtifactFileSystem,
} from "../src/artifact-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const relativeToTemp = relative(resolve(tmpdir()), resolve(directory));
    if (relativeToTemp.startsWith("..") || isAbsolute(relativeToTemp)) {
      throw new Error(`Refusing to remove non-temporary path: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe("ArtifactStore", () => {
  it("round-trips typed JSON through a content-addressed path", async () => {
    const root = await makeTemporaryDirectory();
    const store = new ArtifactStore(root);
    const value = { answer: 42, nested: [true, "é"] };

    const ref = await store.put(value, "json");

    expect(ref.relativePath).toBe(`artifacts/${ref.hash}.json`);
    expect(ref.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(ref)).toBe(true);
    await expect(store.get<typeof value>(ref)).resolves.toEqual(value);
  });

  it("writes and fsyncs before put resolves", async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new ArtifactStore("run", { fileSystem });

    const ref = await store.put({ stable: true }, "json");

    expect(fileSystem.events).toEqual(["mkdir", "read", "open:wx", "write", "sync", "close", "link", "unlink"]);
    expect([...fileSystem.files.keys()]).toEqual([join("run", ref.relativePath)]);
  });

  it("never overwrites an artifact when identical content is written twice", async () => {
    const fileSystem = new MemoryFileSystem();
    const store = new ArtifactStore("run", { fileSystem });

    const first = await store.put({ b: 2, a: 1 }, "json");
    const original = fileSystem.snapshot(join("run", first.relativePath));
    const second = await store.put({ a: 1, b: 2 }, "json");

    expect(second).toEqual(first);
    expect(fileSystem.snapshot(join("run", first.relativePath))).toEqual(original);
    expect(fileSystem.events.filter((event) => event === "write")).toHaveLength(1);
  });

  it("lets concurrent writers of the same content all succeed on a real filesystem", async () => {
    const root = await makeTemporaryDirectory();
    const value = { concurrent: "x".repeat(256 * 1024) };

    // Separate stores stand in for separate processes racing on one run directory.
    const refs = await Promise.all(Array.from({ length: 16 }, () => new ArtifactStore(root).put(value, "json")));

    const [ref] = refs;
    if (ref === undefined) throw new Error("no artifact reference");
    expect(new Set(refs.map(({ hash }) => hash))).toEqual(new Set([ref.hash]));
    await expect(new ArtifactStore(root).get(ref)).resolves.toEqual(value);
    expect(await readdir(join(root, "artifacts"))).toEqual([`${ref.hash}.json`]);
  });

  it("never exposes a partially written artifact to a concurrent writer", async () => {
    const fileSystem = new MemoryFileSystem();
    let release!: () => void;
    fileSystem.pauseNextWrite = new Promise<void>((resolve) => { release = resolve; });
    const first = new ArtifactStore("run", { fileSystem }).put({ racing: true }, "json");
    await fileSystem.writeStarted;

    // The first writer holds its bytes unwritten; the second must neither see nor fail on them.
    const second = await new ArtifactStore("run", { fileSystem }).put({ racing: true }, "json");
    release();

    await expect(first).resolves.toEqual(second);
    expect([...fileSystem.files.keys()]).toEqual([join("run", second.relativePath)]);
  });

  it("repairs an artifact left truncated by a crash instead of failing every later put", async () => {
    const root = await makeTemporaryDirectory();
    const store = new ArtifactStore(root);
    const value = { repaired: true };
    const ref = await store.put(value, "json");
    await rm(join(root, ref.relativePath));
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(join(root, ref.relativePath), "{\"repai");

    await expect(store.put(value, "json")).resolves.toEqual(ref);
    await expect(store.get(ref)).resolves.toEqual(value);
    expect(await readdir(join(root, "artifacts"))).toEqual([`${ref.hash}.json`]);
  });

  it.each([
    ["always", "cheap", 1],
    ["expensive-only", "cheap", 0],
    ["expensive-only", "expensive", 1],
    ["never", "expensive", 0],
  ] as const)("applies the %s policy to %s artifacts", async (fsyncPolicy, durability, count) => {
    const fileSystem = new MemoryFileSystem();
    const store = new ArtifactStore("run", { fileSystem, fsyncPolicy });

    await store.put({ durability }, "json", { durability });

    expect(fileSystem.events.filter((event) => event === "sync")).toHaveLength(count);
  });

  it("defaults to the expensive-only fsync policy", () => {
    expect(new ArtifactStore("run").fsyncPolicy).toBe("expensive-only");
  });

  it("rejects extensions that could escape the artifact directory", async () => {
    const store = new ArtifactStore("run", { fileSystem: new MemoryFileSystem() });
    await expect(store.put({}, "../json")).rejects.toThrow(/Invalid artifact extension/u);
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arbitra-artifact-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

class MemoryFileSystem implements ArtifactFileSystem {
  readonly events: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  pauseNextWrite: Promise<void> | undefined;
  #writeStarted!: () => void;
  readonly writeStarted = new Promise<void>((resolve) => { this.#writeStarted = resolve; });

  async mkdir(): Promise<void> {
    this.events.push("mkdir");
  }

  async open(path: string, flags: "wx"): Promise<ArtifactFileHandle> {
    this.events.push(`open:${flags}`);
    if (this.files.has(path)) {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    this.files.set(path, new Uint8Array());
    return {
      writeFile: async (data) => {
        const pause = this.pauseNextWrite;
        this.pauseNextWrite = undefined;
        if (pause !== undefined) { this.#writeStarted(); await pause; }
        this.events.push("write");
        this.files.set(path, Uint8Array.from(data));
      },
      sync: async () => {
        this.events.push("sync");
      },
      close: async () => {
        this.events.push("close");
      },
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.events.push("read");
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return Uint8Array.from(value);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.events.push("link");
    if (this.files.has(newPath)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.files.set(newPath, this.#require(existingPath));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.events.push("rename");
    this.files.set(newPath, this.#require(oldPath));
    this.files.delete(oldPath);
  }

  async unlink(path: string): Promise<void> {
    this.events.push("unlink");
    this.#require(path);
    this.files.delete(path);
  }

  #require(path: string): Uint8Array {
    const value = this.files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  }

  snapshot(path: string): Uint8Array {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing memory file: ${path}`);
    return Uint8Array.from(value);
  }
}
