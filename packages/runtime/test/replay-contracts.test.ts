import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { featureFixture } from "./feature-fixture.js";
import { testingReplayFixture } from "./replay-fixture.js";
import { decideStages, ReplaySeed, stageIdentities, type ModelReplayMode, type ProtocolPin, type ReplayContract, type ReplayEnvironment } from "../src/replay-contracts.js";
import { RunStore } from "../src/run-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "replay-contracts-")); roots.push(path); return path; }

const pin = (hash = "a"): ProtocolPin => ({ protocolVersion: "1.0.0", protocolHash: hash.repeat(64) });
const environment = (overrides: Partial<ReplayEnvironment> = {}): ReplayEnvironment => ({ repositoryDigest: "d".repeat(64), scope: { kind: "repository" }, protocol: async () => pin(), ...overrides });
async function decide(mode: ModelReplayMode, source: RunConfig, target: RunConfig, sourceEnvironment = environment(), targetEnvironment = environment()) {
  return decideStages(mode, await stageIdentities(mode, source, sourceEnvironment), await stageIdentities(mode, target, targetEnvironment));
}
const summary = (stages: Awaited<ReturnType<typeof decide>>) => stages.map(({ stage, decision, reasons }) => [stage, decision, reasons]);

it("reuses identical Feature stages and invalidates the changed stage and its dependents", async () => {
  const f = await featureFixture(await root());
  expect(summary(await decide("feature", f.config, f.config))).toEqual(["requirements", "exploration", "review", "requirements-revision", "planning"].map((stage) => [stage, "reuse", []]));

  // A changed planner protocol invalidates only planning.
  const protocol = await decide("feature", f.config, f.config, environment(), environment({ protocol: async (id) => pin(id === "planner" ? "b" : "a") }));
  expect(summary(protocol).at(-1)).toEqual(["planning", "regenerate", ["changed:protocols"]]);
  expect(protocol.slice(0, -1).every(({ decision }) => decision === "reuse")).toBe(true);

  // Scope and source changes reach every stage; a request change starts at requirements.
  const scoped = await decide("feature", f.config, runConfigSchema.parse({ ...f.config, scope: { kind: "module", modules: ["src"] } }), environment(), environment({ scope: { kind: "module", modules: ["src"] } }));
  expect(scoped.every(({ decision, reasons }) => decision === "regenerate" && reasons.includes("changed:scope"))).toBe(true);
  const source = await decide("feature", f.config, f.config, environment(), environment({ repositoryDigest: "e".repeat(64) }));
  expect(source.every(({ reasons }) => reasons.includes("changed:repository"))).toBe(true);
  const request = await decide("feature", f.config, runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, feature: { ...f.config.workflow["feature"] as object, request: "Other" } } }));
  expect(summary(request).map(([stage, , reasons]) => [stage, reasons])).toEqual([["requirements", ["changed:settings"]], ["exploration", ["changed:upstream"]], ["review", ["changed:upstream"]], ["requirements-revision", ["changed:upstream"]], ["planning", ["changed:upstream"]]]);

  // Interactive vs automatic requirements is a requirements-contract change.
  const interactive = await decide("feature", f.config, runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, feature: { ...f.config.workflow["feature"] as object, mode: "interactive" } } }));
  expect(interactive[0]).toMatchObject({ decision: "regenerate", reasons: ["changed:settings"] });
});

it("does not let a protocol the source never pinned invalidate a stage, but records it", async () => {
  const f = await featureFixture(await root());
  const decided = await decide("feature", f.config, f.config, environment({ protocol: async (id) => id === "plan-critic" ? null : pin(), unpinned: async () => pin() }));
  expect(decided.at(-1)).toMatchObject({ stage: "planning", decision: "reuse", sourceUnpinnedProtocols: ["plan-critic"] });
  // Without a fallback an unpinned protocol is unknown, and unknown never compares equal.
  const unknown = await decide("feature", f.config, f.config, environment({ protocol: async (id) => id === "plan-critic" ? null : pin() }));
  expect(unknown.at(-1)).toMatchObject({ decision: "regenerate", reasons: ["changed:protocols"] });
});

it("never reuses Testing execution and binds planning to the write grant and verification", async () => {
  const f = await testingReplayFixture(await root());
  const same = await decide("testing", f.config, f.config);
  expect(summary(same)).toEqual([["analysis", "reuse", []], ["planning", "reuse", []], ["execution", "regenerate", ["side_effecting_stage_requires_fresh_evidence"]]]);
  const testing = f.config.workflow["testing"] as { execution: { verification: { execution: { maximumRuns: number } } } };
  const verification = runConfigSchema.parse({ ...f.config, workflow: { ...f.config.workflow, testing: { ...testing, execution: { ...testing.execution, verification: { ...testing.execution.verification, execution: { ...testing.execution.verification.execution, maximumRuns: 8 } } } } } });
  const changed = await decide("testing", f.config, verification);
  expect(changed.map(({ decision }) => decision)).toEqual(["regenerate", "regenerate", "regenerate"]);
  expect(changed[2]?.reasons).toEqual(expect.arrayContaining(["side_effecting_stage_requires_fresh_evidence", "changed:settings"]));
  const analystModel = runConfigSchema.parse({ ...f.config, models: { ...f.config.models, planner: { ...f.config.models["planner"], modelId: "next-model" } } });
  expect((await decide("testing", f.config, analystModel))[0]).toMatchObject({ decision: "regenerate", reasons: ["changed:models"] });
});

it("serves a source output only for a compatible stage and matching activity identity, recording every miss", async () => {
  const path = await root();
  const runs = join(path, "runs");
  const source = new RunStore(runs, "source-run"); const target = new RunStore(runs, "replay-run");
  const key = "model-activity-planner";
  await source.publish(key, { fingerprint: "f", value: { plan: 1 }, replayIdentity: "same" }, "feature/planner/x/turn-0");
  await source.publish("model-activity-legacy", { fingerprint: "f", value: { plan: 1 } }, "feature/planner/y/turn-0");
  const contract = (decision: "reuse" | "regenerate"): ReplayContract => ({ schemaVersion: 1, sourceRunId: "source-run", mode: "feature", sourceRepositoryDigest: "d".repeat(64), repositoryDigest: "d".repeat(64),
    execution: { mode: "none" }, requirements: { decision: "reapprove" },
    stages: [{ stage: "planning", decision, reasons: [], identity: "i", sourceIdentity: "i", sourceUnpinnedProtocols: [] }] });
  const seed = new ReplaySeed(source, target, contract("reuse"));
  expect(await seed.lookup({ activityId: "feature/planner/x/turn-0", key, replayIdentity: "same" })).toMatchObject({ value: { plan: 1 }, sourceRunId: "source-run" });
  expect(await seed.lookup({ activityId: "feature/planner/x/turn-0", key, replayIdentity: "other" })).toBeNull();
  expect(await seed.lookup({ activityId: "feature/planner/y/turn-0", key: "model-activity-legacy", replayIdentity: "same" })).toBeNull();
  expect(await seed.lookup({ activityId: "feature/planner/z/turn-0", key: "model-activity-absent", replayIdentity: "same" })).toBeNull();
  expect(await seed.lookup({ activityId: "feature/exploration/z/turn-0", key: "model-activity-exploration", replayIdentity: "same" })).toBeNull();
  expect(await new ReplaySeed(source, target, contract("regenerate")).lookup({ activityId: "feature/planner/x/turn-0", key: "model-activity-second", replayIdentity: "same" })).toBeNull();
  const records = await Promise.all((await target.listArtifacts()).filter(({ kind }) => kind.startsWith("replay-activity-")).map(async ({ kind, ref }) => [kind, (await target.artifacts.get<{ decision: string; reason?: string }>(ref))] as const));
  expect(Object.fromEntries(records.map(([kind, record]) => [kind, record.reason ?? record.decision]))).toEqual({
    "replay-activity-model-activity-planner": "activity_identity_changed",
    "replay-activity-model-activity-legacy": "source_activity_identity_unavailable",
    "replay-activity-model-activity-absent": "source_activity_absent",
    "replay-activity-model-activity-exploration": "activity_outside_replay_contract",
    "replay-activity-model-activity-second": "stage_invalidated",
  });
  expect(() => new ReplaySeed(target, target, contract("reuse"))).toThrow("REPLAY_SEED_RUN_MISMATCH");
});
