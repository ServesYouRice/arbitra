import { ProtocolRegistry, type PinnedProtocol, type ProtocolControlPlane } from "@arbitra/protocols/registry.js";
import { bundledProtocolControlPlane } from "@arbitra/protocols/bundled.js";
import { assertProtocolId, hashProtocolBytes, parseSemver } from "@arbitra/protocols/versioning.js";
import type { RunStore } from "./run-store.js";

/** The versions an Audit uses for a protocol its run does not select. Every stage that predicts or pins an Audit's
 * protocols (the run itself, an incremental audit's reuse, a replay) reads this one map, or they disagree on what an
 * unselected protocol is. The critic asks only what code cannot check from 1.1.0 (October 14, 2026); discovery reads
 * beyond its unit from production-audit 2.0.0 (October 25, 2026), and refuses to resume a run pinned earlier. */
export const AUDIT_PROTOCOL_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({ "plan-critic": "1.1.0", "production-audit": "2.0.0" });

/**
 * Pins trusted bytes once per run. Restarts and replays read the recorded content. `selections` are the run's own
 * choices (`config.protocols`); `defaults` are the caller's versions for a protocol the run does not select, and
 * 1.0.0 is the default of every other.
 */
export class ModelProtocols {
  private readonly pending = new Map<string, Promise<PinnedProtocol>>();
  private readonly registry: ProtocolRegistry;

  constructor(private readonly store: RunStore, private readonly selections: Readonly<Record<string, unknown>>, controlPlane: ProtocolControlPlane = bundledProtocolControlPlane(), private readonly defaults: Readonly<Record<string, string>> = {}) {
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
    const explicit = (Object.hasOwn(this.selections, id) ? this.selections[id] : undefined) ?? (Object.hasOwn(this.selections, alias) ? this.selections[alias] : undefined);
    const selected = explicit ?? (Object.hasOwn(this.defaults, id) ? this.defaults[id] : undefined) ?? "1.0.0";
    if (typeof selected !== "string") throw new Error(`INVALID_PROTOCOL_SELECTION:${id}`);
    parseSemver(selected);
    const kind = `model-protocol-${id}`;
    const existing = (await this.store.listArtifacts()).find((artifact) => artifact.kind === kind);
    if (existing !== undefined) {
      const stored = JSON.parse((await this.store.readArtifact(existing.artifactId)).content) as PinnedProtocol;
      // A version the run selected must be the one it pinned. A default only chooses for a run that has no pin: a run
      // that pinned an earlier default keeps it on a later build (the audit critic's default moved to 1.1.0
      // under runs pinned at 1.0.0, and their resume failed here). The pinned bytes are checked either way.
      const version = explicit === undefined && typeof stored.protocolVersion === "string" ? stored.protocolVersion : selected;
      if (stored.protocolId !== id || stored.protocolVersion !== version || typeof stored.content !== "string"
        || hashProtocolBytes(new TextEncoder().encode(stored.content)) !== stored.protocolHash) throw new Error(`INVALID_STORED_PROTOCOL:${id}`);
      // Re-validate metadata and trust classification through the production registry.
      return new ProtocolRegistry({ async read() { return { protocolBytes: new TextEncoder().encode(stored.content), metadataBytes: new TextEncoder().encode(JSON.stringify(stored.metadata)), source: stored.source, sourceRevision: stored.sourceRevision }; }, async listVersions() { return [version]; } }).resolve(id, version);
    }
    const protocol = await this.registry.resolve(id, selected);
    await this.store.publish(kind, protocol);
    return protocol;
  }
}
