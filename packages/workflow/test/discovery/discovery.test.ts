import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allocateDiscoveryScopes } from "../../src/nodes/discovery/depth.js";
import { discoveryNode, ROUND_ZERO_CONTEXT_POLICY, type DiscoveryNodeConfig, type DiscoveryRequest, type DiscoverySourceResult } from "../../src/nodes/discovery/node.js";

const modules = [
  { id: "auth", files: ["src/auth.ts"] }, { id: "billing", files: ["src/billing.ts"] },
  { id: "catalog", files: ["src/catalog.ts"] }, { id: "search", files: ["src/search.ts"] },
] as const;
const hotspots = [{ path: "src/catalog.ts", score: 1, rank: 1 }];
const protocol = { protocolId: "production-audit", protocolVersion: "1.0.0", protocolHash: "a".repeat(64) };
function config(changes: Partial<DiscoveryNodeConfig> = {}): DiscoveryNodeConfig { return { auditors: ["auditor-a", "auditor-b", "auditor-c"].map((auditorId) => ({ auditorId, modelProfileId: auditorId })), depth: "balanced", modules, hotspots, protocol, nodeTokenBudget: 1_000, structuredEmissionReserveTokens: 100, ...changes }; }
const baseline = [
  { kind: "snapshot_identity", provenance: "deterministic", ref: "snapshot.json", tokenEstimate: 20 },
  { kind: "preflight", provenance: "deterministic", ref: "project-context.json", tokenEstimate: 20 },
  { kind: "manifest", provenance: "deterministic", ref: "package.json", tokenEstimate: 10 },
  { kind: "audit_protocol", provenance: "deterministic", ref: "protocol.md", tokenEstimate: 30 },
] as const;

describe("independent discovery", () => {
  it("declares and enforces a deterministic-only round-zero edge context", async () => {
    expect(ROUND_ZERO_CONTEXT_POLICY).toMatchObject({ mode: "selected_artifacts", include: ["snapshot_identity", "preflight", "manifest", "audit_protocol", "assigned_scope"] });
    const node = discoveryNode(config(), { async run() { throw new Error("not reached"); } }, { async persist() { return "unused"; } });
    await expect(node.run([...baseline, { kind: "peer_findings", provenance: "model", ref: "peer.json", tokenEstimate: 1 }])).rejects.toThrow("ROUND_ZERO_MODEL_CONTEXT_FORBIDDEN:peer.json");
  });

  it("fans out three isolated auditors and persists three namespaced source sets", async () => {
    const requests: DiscoveryRequest[] = []; const persisted = new Map<string, DiscoverySourceResult>();
    const node = discoveryNode(config(), { async run(request) { requests.push(request); return { auditorId: request.auditor.auditorId, findings: [{ sourceFindingId: `${request.auditor.auditorId}/SEC-001`, findingKey: "auth-bypass" }], truncated: false, unexaminedDueToBudget: [], limitations: [] }; } }, { async persist(auditorId, result) { persisted.set(auditorId, result); return `results/${auditorId}.json`; } });
    const run = await node.run(baseline);
    expect(requests).toHaveLength(3); expect(persisted.size).toBe(3); expect(Object.keys(run.sourceResultRefs)).toEqual(["auditor-a", "auditor-b", "auditor-c"]);
    expect(requests.every(({ artifacts, forbiddenContextSources }) => artifacts.every(({ provenance }) => provenance === "deterministic") && forbiddenContextSources.includes("shared_advisor"))).toBe(true);
    expect(run.protocol).toEqual(protocol);
  });

  it("partitions by module with preset-specific risk overlap", () => {
    const auditors = ["a", "b", "c"];
    const fast = allocateDiscoveryScopes("fast", auditors, modules, hotspots);
    const balanced = allocateDiscoveryScopes("balanced", auditors, modules, hotspots);
    const deep = allocateDiscoveryScopes("deep", auditors, modules, hotspots);
    expect(fast.every(({ overlapModuleIds }) => overlapModuleIds.includes("auth") && overlapModuleIds.includes("billing"))).toBe(true);
    expect(balanced.every(({ overlapModuleIds }) => overlapModuleIds.includes("catalog"))).toBe(true);
    expect(deep.every(({ moduleIds }) => moduleIds.length === modules.length)).toBe(true);
  });

  it("forces structured truncation and lists unexamined modules near budget", async () => {
    const requests: DiscoveryRequest[] = [];
    const node = discoveryNode(config({ auditors: [{ auditorId: "auditor-a", modelProfileId: "fake" }], nodeTokenBudget: 100, structuredEmissionReserveTokens: 20 }), { async run(request) { requests.push(request); return { auditorId: "auditor-a", findings: [], truncated: false, unexaminedDueToBudget: [], limitations: [] }; } }, { async persist() { return "result.json"; } });
    const run = await node.run([{ kind: "snapshot_identity", provenance: "deterministic", ref: "snapshot", tokenEstimate: 85 }]);
    expect(requests[0]!.forceStructuredEmission).toBe(true); expect(run.results[0]).toMatchObject({ truncated: true, limitations: ["node_token_budget"] }); expect(run.results[0]!.unexaminedDueToBudget.length).toBeGreaterThan(0);
  });

  it("records degraded independence whenever a shared reasoning source is enabled", async () => {
    const node = discoveryNode(config({ auditors: [{ auditorId: "auditor-a", modelProfileId: "fake" }], sharedReasoningSource: "shared_advisor" }), { async run(request) { return { auditorId: request.auditor.auditorId, findings: [], truncated: false, unexaminedDueToBudget: [], limitations: [] }; } }, { async persist() { return "result.json"; } });
    expect((await node.run(baseline)).independence).toEqual({ degraded: true, reason: "shared_advisor" });
  });

  it("ships the pinned production protocol asset with complete non-fixture metadata", async () => {
    const root = resolve(process.cwd(), "..", "protocols", "assets", "production-audit", "1.0.0");
    const bytes = await readFile(resolve(root, "protocol.md")); const metadata = JSON.parse(await readFile(resolve(root, "metadata.json"), "utf8")) as Record<string, unknown>;
    const protocolHash = createHash("sha256").update(bytes).digest("hex");
    expect(protocolHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata).toMatchObject({ author: "Arbitra", date: "2026-08-22" }); expect(metadata.fixture).toBeUndefined();
    const node = discoveryNode(config({ auditors: [{ auditorId: "auditor-a", modelProfileId: "fake" }], protocol: { protocolId: "production-audit", protocolVersion: "1.0.0", protocolHash } }), { async run(request) { return { auditorId: request.auditor.auditorId, findings: [], truncated: false, unexaminedDueToBudget: [], limitations: [] }; } }, { async persist() { return "result.json"; } });
    expect((await node.run(baseline)).protocol.protocolHash).toBe(protocolHash);
  });
});
