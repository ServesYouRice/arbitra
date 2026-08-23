import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAuditAcceptance, type FakeModels } from "../src/fresh-executor.js";

interface AuditContract {
  readonly fixtureId: string;
  readonly requiredStageEvents: readonly string[];
  readonly requiredArtifacts: readonly string[];
}

const fixtureRoot = new URL("../fixtures/handoff/", import.meta.url);
const contract = readJson<AuditContract>("audit-contract.json");
const fakeModels: FakeModels = { responses: readJson<Record<string, unknown>>("fake-models.json") };

describe("canonical Audit acceptance fixture", () => {
  it("executes every canonical stage and persists every required artifact through rendering", async () => {
    const result = await runFixture();

    expect(result.stageEvents).toEqual(contract.requiredStageEvents);
    expect(Object.keys(result.artifacts).sort()).toEqual([...contract.requiredArtifacts].sort());
    expect(result.implementationTree["manifest.json"]).toBeDefined();
    expect(result.implementationTree["tasks/TASK-001/task.md"]).toContain("TASK-001");
    expect(JSON.parse(result.artifacts["project-context.json"]!) as unknown).toMatchObject({ intensity: { effective: "DEEP" }, projectContext: { repository: { commit: "fixture", scope: { kind: "full" } } } });
    expect(JSON.parse(result.artifacts["issue-board.json"]!) as unknown).toMatchObject({ operationIds: ["cluster:C-DEFECT", "cluster:C-DECOY"] });
  });

  it("uses delta-only round two, deterministic verification, and degraded critic coverage", async () => {
    const result = await runFixture();

    expect(result.peerReview).toEqual({ rounds: 2, earlyStop: true, roundTwoCandidateIds: ["C-DEFECT"] });
    expect(result.verification).toEqual({ resolvedDisputes: 1, modelCalls: 0 });
    expect(result.critic).toEqual({ status: "skipped", degradedReviewCoverage: true });
  });

  it("routes every fake model response through the provider invocation runtime", async () => {
    const result = await runFixture();
    const traces = result.providerTraces as readonly { readonly outcome?: string; readonly activityId?: string }[];

    expect(traces).toHaveLength(7);
    expect(traces.every(({ outcome }) => outcome === "completed")).toBe(true);
    expect(new Set(traces.map(({ activityId }) => activityId))).toEqual(new Set(Object.keys(fakeModels.responses)));
  });

  it.each([
    ["stage", contract.requiredStageEvents, contract.requiredStageEvents[0]],
    ["artifact", contract.requiredArtifacts, contract.requiredArtifacts[0]],
  ] as const)("makes a missing required %s observable", (_kind, inventory, omitted) => {
    expect(inventory.filter((item) => item !== omitted)).not.toContain(omitted);
    expect(inventory).toContain(omitted);
  });
});

async function runFixture() {
  return runAuditAcceptance({ fixtureId: contract.fixtureId, repositoryDir: fileURLToPath(new URL("repository/", fixtureRoot)) }, fakeModels);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, fixtureRoot), "utf8")) as T;
}
