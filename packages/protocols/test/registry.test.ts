import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ProtocolRegistry,
  createTestProtocolRegistry,
  type ProtocolAsset,
  type ProtocolControlPlane,
} from "../src/registry.js";
import { assertRunProtocolPin, createRunProtocolPin, hashProtocolBytes } from "../src/versioning.js";

const fixtureRoot = resolve(process.cwd(), "test", "fixtures");

class FixtureControlPlane implements ProtocolControlPlane {
  async read(id: string, version: string): Promise<ProtocolAsset | null> {
    try {
      const directory = resolve(fixtureRoot, id, version);
      return {
        protocolBytes: await readFile(resolve(directory, "protocol.md")),
        metadataBytes: await readFile(resolve(directory, "metadata.json")),
        source: "test_fixture",
        sourceRevision: null,
      };
    } catch {
      return null;
    }
  }

  async listVersions(id: string): Promise<readonly string[]> {
    return id === "registry-fixture" ? ["1.0.0"] : [];
  }
}

describe("ProtocolRegistry", () => {
  const source = new FixtureControlPlane();

  it("rejects fixture assets from production resolution", async () => {
    await expect(new ProtocolRegistry(source).resolve("registry-fixture", "1.0.0"))
      .rejects.toThrow("cannot be resolved by the production registry");
  });

  it("resolves exact bytes to an immutable pinned triple in explicit test mode", async () => {
    const protocol = await createTestProtocolRegistry(source).select("registry-fixture", "1.0.0");
    const bytes = await readFile(resolve(fixtureRoot, "registry-fixture", "1.0.0", "protocol.md"));
    expect(protocol).toMatchObject({
      protocolId: "registry-fixture",
      protocolVersion: "1.0.0",
      protocolHash: hashProtocolBytes(bytes),
      source: "test_fixture",
    });
    expect(Object.isFrozen(protocol)).toBe(true);
    expect(protocol.metadata.fixture).toBe(true);
  });

  it("forks to a new version and editing changes the byte hash without mutating history", async () => {
    const registry = createTestProtocolRegistry(source);
    const original = await registry.resolve("registry-fixture", "1.0.0");
    const fork = await registry.fork("registry-fixture", "1.0.0");
    const edited = registry.edit(fork, `${fork.content}\nRequire explicit limitations.\n`);
    expect(fork.protocolVersion).toBe("1.0.1");
    expect(edited.protocolVersion).toBe("1.0.1");
    expect(edited.protocolHash).not.toBe(original.protocolHash);
    expect(original.content).not.toContain("explicit limitations");
    expect(registry.diff(original, edited)).toMatchObject({
      changed: true,
      lines: expect.arrayContaining([
        { kind: "added", text: "Require explicit limitations." },
      ]),
    });
  });

  it("duplicates under a new id without changing the source identity", async () => {
    const registry = createTestProtocolRegistry(source);
    const duplicate = await registry.duplicate("registry-fixture", "1.0.0", "user-copy");
    expect(duplicate).toMatchObject({
      protocolId: "user-copy",
      protocolVersion: "1.0.0",
      forkedFrom: { protocolId: "registry-fixture", protocolVersion: "1.0.0" },
    });
  });

  it("requires every run artifact to carry the complete pinned triple", async () => {
    const protocol = await createTestProtocolRegistry(source).resolve("registry-fixture", "1.0.0");
    const artifact = { runId: "run-1", protocol: createRunProtocolPin(protocol) };
    expect(() => assertRunProtocolPin(artifact.protocol)).not.toThrow();
    expect(() => assertRunProtocolPin({
      protocolId: protocol.protocolId,
      protocolVersion: protocol.protocolVersion,
    })).toThrow("protocolId, protocolVersion and protocolHash");
  });

  it("hashes whitespace edits because hashes cover protocol bytes", () => {
    expect(hashProtocolBytes(new TextEncoder().encode("rule\n")))
      .not.toBe(hashProtocolBytes(new TextEncoder().encode("rule \n")));
  });
});
