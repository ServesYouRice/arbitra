import { mkdtemp, rm } from "node:fs/promises";
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

    expect(fileSystem.events).toEqual(["mkdir", "open:wx", "write", "sync", "close"]);
    expect(fileSystem.files.has(join("run", ref.relativePath))).toBe(true);
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

  snapshot(path: string): Uint8Array {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing memory file: ${path}`);
    return Uint8Array.from(value);
  }
}
