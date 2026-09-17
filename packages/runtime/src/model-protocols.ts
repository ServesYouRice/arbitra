import { ProtocolRegistry, type PinnedProtocol, type ProtocolControlPlane } from "@arbitra/protocols/registry.js";
import { bundledProtocolControlPlane } from "@arbitra/protocols/bundled.js";
import { assertProtocolId, hashProtocolBytes, parseSemver } from "@arbitra/protocols/versioning.js";
import type { RunStore } from "./run-store.js";

/** Pins trusted bytes once per run. Restarts and replays read the recorded content. */
export class ModelProtocols {
  private readonly pending = new Map<string, Promise<PinnedProtocol>>();
  private readonly registry: ProtocolRegistry;

  constructor(private readonly store: RunStore, private readonly selections: Readonly<Record<string, unknown>>, controlPlane: ProtocolControlPlane = bundledProtocolControlPlane()) {
    this.registry = new ProtocolRegistry(controlPlane);
  }

  resolve(id: string): Promise<PinnedProtocol> {
    assertProtocolId(id);
    const prior = this.pending.get(id);
    if (prior !== undefined) return prior;
    const pending = this.pin(id);
    this.pending.set(id, pending);
    void pending.catch(() => { this.pending.delete(id); });
    return pending;
  }

  private async pin(id: string): Promise<PinnedProtocol> {
    const alias = id === "production-audit" ? "audit" : id === "targeted-verification" ? "verification" : id;
    const selected = (Object.hasOwn(this.selections, id) ? this.selections[id] : undefined) ?? (Object.hasOwn(this.selections, alias) ? this.selections[alias] : undefined) ?? "1.0.0";
    if (typeof selected !== "string") throw new Error(`INVALID_PROTOCOL_SELECTION:${id}`);
    parseSemver(selected);
    const kind = `model-protocol-${id}`;
    const existing = (await this.store.listArtifacts()).find((artifact) => artifact.kind === kind);
    if (existing !== undefined) {
      const stored = JSON.parse((await this.store.readArtifact(existing.artifactId)).content) as PinnedProtocol;
      if (stored.protocolId !== id || stored.protocolVersion !== selected || typeof stored.content !== "string"
        || hashProtocolBytes(new TextEncoder().encode(stored.content)) !== stored.protocolHash) throw new Error(`INVALID_STORED_PROTOCOL:${id}`);
      // Re-validate metadata and trust classification through the production registry.
      return new ProtocolRegistry({ async read() { return { protocolBytes: new TextEncoder().encode(stored.content), metadataBytes: new TextEncoder().encode(JSON.stringify(stored.metadata)), source: stored.source, sourceRevision: stored.sourceRevision }; }, async listVersions() { return [selected]; } }).resolve(id, selected);
    }
    const protocol = await this.registry.resolve(id, selected);
    await this.store.publish(kind, protocol);
    return protocol;
  }
}
