import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledProtocolControlPlane } from "@arbitra/protocols/bundled.js";
import { ProtocolRegistry, type ProtocolControlPlane } from "@arbitra/protocols/registry.js";
import { ModelProtocols } from "../src/model-protocols.js";
import { RunStore } from "../src/run-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function store() {
  const root = await mkdtemp(join(tmpdir(), "arbitra-protocols-")); directories.push(root); return new RunStore(root, "run-1");
}
function plane(text: string): ProtocolControlPlane {
  return { async read() { return { protocolBytes: new TextEncoder().encode(text), metadataBytes: new TextEncoder().encode(JSON.stringify({ author: "Fixture", date: "2026-09-16", rationale: "Test external config pinning", compatibilityNotes: [] })), source: "external_config", sourceRevision: null }; }, async listVersions() { return ["1.0.0"]; } };
}

describe("run protocol pins", () => {
  it("loads shipped protocols through the production registry", async () => {
    const registry = new ProtocolRegistry(bundledProtocolControlPlane());
    const pinned = await registry.resolve("production-audit", "1.0.0");
    expect(pinned.content).toContain("Production Audit Protocol");
    expect(pinned.source).toBe("trusted_base");
    expect((await registry.resolve("targeted-verification", "1.0.0")).content).toContain("STILL_NEEDS_VERIFICATION");
    await expect(registry.resolve("production-audit", "9.9.9")).rejects.toThrow("was not found");
  });

  it("retains pinned bytes after restart even if the control plane changes", async () => {
    const run = await store();
    const first = new ModelProtocols(run, { audit: "1.0.0" }, plane("Original protocol"));
    const pins = await Promise.all([first.resolve("production-audit"), first.resolve("production-audit")]);
    expect(pins[0]).toEqual(pins[1]);
    const changed = plane("Changed protocol"); const read = vi.spyOn(changed, "read");
    const restored = await new ModelProtocols(run, {}, changed).resolve("production-audit");
    expect(restored).toEqual(pins[0]); expect(read).not.toHaveBeenCalled();
  });

  it("rejects edited protocol pins and changed version selections", async () => {
    const run = await store();
    const pin = await new ModelProtocols(run, {}, plane("Original")).resolve("planner");
    await expect(new ModelProtocols(run, { planner: "2.0.0" }, plane("Changed")).resolve("planner")).rejects.toThrow("INVALID_STORED_PROTOCOL");
    await run.publish("model-protocol-planner", { ...pin, content: "Tampered" });
    await expect(new ModelProtocols(run, {}, plane("Changed")).resolve("planner")).rejects.toThrow("INVALID_STORED_PROTOCOL");
  });

  it("honors the verification selector used by shipped configurations", async () => {
    const run = await store();
    await expect(new ModelProtocols(run, { verification: "9.9.9" }).resolve("targeted-verification")).rejects.toThrow("was not found");
    expect((await new ModelProtocols(run, { verification: "9.9.9", "targeted-verification": "1.0.0" }).resolve("targeted-verification")).protocolVersion).toBe("1.0.0");
  });

  it("rejects test fixtures at the production boundary", async () => {
    const run = await store(); const base = plane("Fixture");
    const source: ProtocolControlPlane = { ...base, async read(id, version) { const asset = await base.read(id, version); return asset === null ? null : { ...asset, source: "test_fixture" }; } };
    await expect(new ModelProtocols(run, {}, source).resolve("planner")).rejects.toThrow("Test fixture protocols");
    expect(await run.listArtifacts()).toEqual([]);
  });
});
