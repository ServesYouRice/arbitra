import { describe, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { readFileSync } from "node:fs";
import { decideUnit, discoveryUnitActivity, discoveryUnitIdentity, findingLineage, unitEnvironment, type DiscoveryUnitRecord, type SnapshotIdentity } from "../src/incremental-audit.js";
import type { RepositorySnapshot } from "../src/repository.js";
import { createHash } from "node:crypto";

const example = runConfigSchema.parse(JSON.parse(readFileSync(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
const config = runConfigSchema.parse({ ...example, workflow: { preset: "audit-balanced", modelExecution: {
  endpoints: [{ id: "a", providerId: "openai", transport: "openai-responses", endpoint: "https://a.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }, { id: "b", providerId: "anthropic", transport: "anthropic-messages", endpoint: "https://b.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
  modelEndpoints: { "auditor-a": "a", "auditor-b": "b", planner: "a" }, roles: { planner: "planner", verifier: "planner" }, maximumOutputTokens: 1000, maximumTokens: 100_000, timeoutMs: 1000, maximumRetries: 0, rateLimits: { openai: { rpm: 10, tpm: 10000, maxConcurrent: 1 }, anthropic: { rpm: 10, tpm: 10000, maxConcurrent: 1 } },
} } });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function snapshot(files: Record<string, string>): { snapshot: RepositorySnapshot; identity: SnapshotIdentity } {
  const entries = Object.entries(files).map(([path, text]) => ({ path, lines: text.split("\n"), byteLength: Buffer.byteLength(text), lineStartBytes: [] }));
  return { snapshot: { root: "/fixture", files: entries }, identity: { schemaVersion: 1, repositoryDigest: "d", gitHead: null, files: Object.fromEntries(entries.map(({ path, lines }) => [path, hash(lines.join("\n"))])), manifests: { "package.json": hash("{}") } } };
}

const unit = { auditorId: "auditor-a", scopeId: "scope-1", activityId: "auditor-a/scope-1/discovery", paths: ["src/a.ts"] };
function record(files: Record<string, string>, overrides: Partial<DiscoveryUnitRecord> = {}): DiscoveryUnitRecord {
  const { snapshot: current, identity } = snapshot(files);
  return { schemaVersion: 1, unitKey: "auditor-a-scope-1", auditorId: "auditor-a", scopeId: "scope-1", activityId: unit.activityId, paths: unit.paths, window: null,
    identity: discoveryUnitIdentity(unit, unitEnvironment(current, identity, config)), citedRanges: [{ sourceFindingId: "auditor-a/scope-1/1", path: "src/a.ts", startLine: 2, endLine: 2, sha256: hash("bad();"), text: "bad();" }],
    inspection: { recorded: true, readPaths: ["src/a.ts"], searchScopes: [] }, findingsKind: "findings-auditor-a-scope-1", sourceFindingIds: ["auditor-a/scope-1/1"], ...overrides };
}
function decide(files: Record<string, string>, base: DiscoveryUnitRecord | null, options: { manifests?: Record<string, string>; hasRecords?: boolean } = {}) {
  const { snapshot: current, identity } = snapshot(files);
  const environment = unitEnvironment(current, { ...identity, ...(options.manifests === undefined ? {} : { manifests: options.manifests }) }, config);
  return decideUnit(discoveryUnitIdentity(unit, environment), base, { baseHasUnitRecords: options.hasRecords ?? true, files: new Map(current.files.map(({ path, lines }) => [path, lines])), imports: environment.imports });
}

const v1 = { "src/a.ts": 'import "../lib/dep.js";\nbad();\nok();', "lib/dep.ts": "export const dep = 1;", "src/other.ts": "other();" };

describe("discovery unit identity", () => {
  it("reuses only an identical unit and names every changed component", () => {
    expect(decide(v1, record(v1))).toEqual({ decision: "reuse", reasons: [] });
    // Unrelated files are outside the unit's footprint and closure.
    expect(decide({ ...v1, "src/other.ts": "changed();" }, record(v1))).toEqual({ decision: "reuse", reasons: [] });
    // An import outside the unit (a split module) is part of its identity.
    expect(decide({ ...v1, "lib/dep.ts": "export const dep = 2;" }, record(v1)).reasons).toEqual(["changed:imports:lib/dep.ts"]);
    expect(decide({ ...v1, "src/a.ts": 'import "../lib/dep.js";\nbad();\nok(1);' }, record(v1)).reasons).toEqual(["changed:footprint:src/a.ts"]);
    expect(decide({ ...v1, "src/a.ts": 'import "../lib/dep.js";\nworse();\nok();' }, record(v1)).reasons).toEqual(["changed:footprint:src/a.ts", "changed:cited_lines:src/a.ts:2-2"]);
    expect(decide(v1, record(v1), { manifests: { "package.json": hash('{"type":"module"}') } }).reasons).toEqual(["changed:manifests:package.json"]);
    expect(decide(v1, record(v1), { manifests: { "package.json": "unreadable" } }).reasons).toEqual(["changed:manifests:package.json", "manifest_unverifiable:package.json"]);
  });

  it("never treats a missing record or footprint as equal", () => {
    expect(decide(v1, null)).toEqual({ decision: "regenerate", reasons: ["base_unit_absent"] });
    expect(decide(v1, null, { hasRecords: false })).toEqual({ decision: "regenerate", reasons: ["base_unit_identity_unavailable"] });
    expect(decide(v1, record(v1, { inspection: { recorded: false, readPaths: [], searchScopes: [] } })).reasons).toEqual(["base_footprint_unavailable"]);
    expect(decide(v1, record(v1, { inspection: { recorded: true, readPaths: ["src/a.ts", "src/other.ts"], searchScopes: [] } })).reasons).toEqual(["footprint_outside_unit:src/other.ts"]);
    const changedModel = { ...record(v1) }; changedModel.identity = { ...changedModel.identity, model: "different" };
    expect(decide(v1, changedModel).reasons).toEqual(["changed:model"]);
  });

  it("identifies discovery units and their harness turns only", () => {
    expect(discoveryUnitActivity("auditor-a/scope-1/discovery/turn-3")).toBe("auditor-a/scope-1/discovery");
    expect(discoveryUnitActivity("auditor-a/discovery")).toBe("auditor-a/discovery");
    expect(discoveryUnitActivity("peer-review/1/auditor-a/turn-0")).toBeNull();
  });

  it("re-anchors base findings by exact content only", () => {
    const base = record(v1, { citedRanges: [
      { sourceFindingId: "f/unchanged", path: "src/a.ts", startLine: 2, endLine: 2, sha256: hash("bad();"), text: "bad();" },
      { sourceFindingId: "f/moved", path: "src/a.ts", startLine: 3, endLine: 3, sha256: hash("ok();"), text: "ok();" },
      { sourceFindingId: "f/absent", path: "src/other.ts", startLine: 1, endLine: 1, sha256: hash("other();"), text: "other();" },
      { sourceFindingId: "f/redacted", path: "src/other.ts", startLine: 1, endLine: 1, sha256: hash("secret"), text: "[REDACTED]" },
      { sourceFindingId: "f/ambiguous", path: "lib/gone.ts", startLine: 1, endLine: 1, sha256: hash("dup();"), text: "dup();" },
    ] });
    const { snapshot: current } = snapshot({ "src/a.ts": 'import "../lib/dep.js";\nbad();\n// inserted\nok();', "lib/dep.ts": "dup();\ndup();", "src/other.ts": "Other();" });
    const lineage = Object.fromEntries(findingLineage([base], current).map(({ sourceFindingId, status, locations }) => [sourceFindingId, { status, to: locations[0]?.to }]));
    expect(lineage).toEqual({ "f/unchanged": { status: "unchanged", to: undefined }, "f/moved": { status: "moved", to: { path: "src/a.ts", startLine: 4, endLine: 4 } },
      "f/absent": { status: "absent", to: undefined }, "f/redacted": { status: "unverifiable", to: undefined }, "f/ambiguous": { status: "ambiguous", to: undefined } });
  });
});
