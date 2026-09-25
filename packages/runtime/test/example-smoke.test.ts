import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { orchestratorCore } from "../src/cli-core.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";
import { SMOKE_SOURCE, SMOKE_TEST, smokeProvider, smokeRepository, type WireProtocol } from "./smoke-provider.js";

/**
 * Credential-free smoke checks of every shipped model-backed template, unmodified,
 * through the public CLI core and orchestrator. Only the HTTP client, the credential
 * lookup and the Docker sandbox are replaced by fixtures; no network or engine is used.
 * Passing proves configuration, preflight and runtime wiring — not model quality.
 */
const TEMPLATES = new URL("../../../examples/model-backed/", import.meta.url);
const roots: string[] = [];
const exercised = new Set<WireProtocol>();
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(name: string, options: { highImpactAmbiguity?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), `arbitra-smoke-${name}-`)); roots.push(root);
  await smokeRepository(root);
  const configPath = join(root, `${name}.json`);
  // Outside the snapshot: `.runs` and the config path must not become audited source.
  await writeFile(configPath, await readFile(new URL(`${name}.json`, TEMPLATES), "utf8"));
  const provider = await smokeProvider(options);
  const orchestrator = () => new Orchestrator({ repository: root, stateDirectory: join(root, ".runs"), providerOptions: provider.providerOptions, testSandbox: provider.sandbox });
  return { root, configPath, provider, orchestrator, core: orchestratorCore(orchestrator()) };
}

async function artifactKinds(orchestrator: Orchestrator, runId: string): Promise<string[]> {
  return (await orchestrator.artifacts(runId)).map(({ kind }) => kind);
}

async function readArtifact(orchestrator: Orchestrator, runId: string, kind: string): Promise<unknown> {
  const descriptor = (await orchestrator.artifacts(runId)).find((artifact) => artifact.kind === kind);
  if (descriptor === undefined) throw new Error(`SMOKE_ARTIFACT_ABSENT:${kind}`);
  return JSON.parse((await orchestrator.artifact(runId, descriptor.artifactId) as { content: string }).content);
}

describe("model-backed template smoke checks", () => {
  it("lists exactly the documented model-backed templates", async () => {
    expect((await readdir(TEMPLATES)).filter((name) => name.endsWith(".json")).sort()).toEqual([
      "audit-compatible-chat.json", "audit-mixed-providers.json", "feature-automatic.json", "feature-interactive.json", "testing-execute.json", "testing-plan.json",
    ]);
  });

  it.each(["audit-mixed-providers", "audit-compatible-chat"])("runs %s to a durable plan", async (name) => {
    const f = await setup(name);
    const validation = await f.core.validate(f.configPath);
    expect(validation.value).toMatchObject({ valid: true, ready: true, mode: "audit", modelBacked: true, diagnostics: [] });
    const result = await f.core.run(f.configPath);
    const value = result.value as { runId: string; state: string; summary: { limitations: string[] } };
    expect(value.state).toBe("COMPLETED");
    // Model Audit is source-only, so security coverage is honestly degraded and the
    // CI gate fails with degraded_coverage even though the run itself completed.
    expect(result).toMatchObject({ disposition: "failed", reasons: ["degraded_coverage"] });
    expect(value.summary.limitations).toContain("auditor_kind:model_auditors");
    const orchestrator = f.orchestrator();
    const kinds = await artifactKinds(orchestrator, value.runId);
    expect(kinds).toContain("plan-ir");
    for (const call of f.provider.calls) exercised.add(call.protocol);
    const stages = new Set(f.provider.calls.map(({ stage }) => stage));
    for (const stage of ["discovery", "review", "audit-planner"]) expect(stages).toContain(stage);
    if (name === "audit-mixed-providers") expect(stages).toContain("audit-critic");
    expect(await readFile(join(f.root, "src", "session.ts"), "utf8")).toBe(`${SMOKE_SOURCE}\n`);
  }, 60_000);

  it("pauses interactive Feature for approval, then resumes to an exported handoff", async () => {
    const f = await setup("feature-interactive", { highImpactAmbiguity: true });
    expect((await f.core.validate(f.configPath)).value).toMatchObject({ valid: true, ready: true, mode: "feature" });
    const blocked = await f.core.run(f.configPath);
    expect(blocked.disposition).toBe("suspended");
    const runId = (blocked.value as { runId: string }).runId;
    const requirements = await f.orchestrator().requirements(runId) as { artifactId: string; pendingAmbiguityIds: string[] };
    expect(requirements.pendingAmbiguityIds).toEqual(["migration"]);
    await f.core.approveRequirements(runId, requirements.artifactId, ["migration"]);
    const resumed = await orchestratorCore(f.orchestrator()).resume(runId);
    expect(resumed).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed" } });
    const exported = await f.core.exportRun(runId, "json");
    const handoff = (exported.value as { artifacts: Record<string, { content: string }> }).artifacts["implementation"];
    if (handoff === undefined) throw new Error("SMOKE_HANDOFF_ABSENT");
    const tree = JSON.parse(handoff.content) as Record<string, string>;
    expect(JSON.parse(tree["manifest.json"] ?? "{}")).toMatchObject({ run: { mode: "feature" } });
    for (const call of f.provider.calls) exercised.add(call.protocol);
  }, 60_000);

  it("runs automatic Feature without operator checkpoints", async () => {
    const f = await setup("feature-automatic");
    const result = await f.core.run(f.configPath);
    expect(result).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed" } });
    const runId = (result.value as { runId: string }).runId;
    expect(await artifactKinds(f.orchestrator(), runId)).toContain("implementation");
    for (const call of f.provider.calls) exercised.add(call.protocol);
  }, 60_000);

  it("plans tests without executing commands or touching the source tree", async () => {
    const f = await setup("testing-plan");
    const result = await f.core.run(f.configPath);
    expect(result).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed", summary: { outcome: { testsExecuted: false, selectedGaps: 1 } } } });
    expect(f.provider.checks()).toBe(0);
    expect(await readFile(join(f.root, "test", "session.test.ts"), "utf8")).toBe(`${SMOKE_TEST}\n`);
    for (const call of f.provider.calls) exercised.add(call.protocol);
  }, 60_000);

  it("executes granted test writes in an isolated worktree and exports a verified change set", async () => {
    const f = await setup("testing-execute");
    expect((await f.core.validate(f.configPath)).value).toMatchObject({ valid: true, ready: true, preset: "testing-execute" });
    const result = await f.core.run(f.configPath);
    expect(result).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed", summary: { execution: { passed: true } } } });
    const runId = (result.value as { runId: string }).runId;
    const orchestrator = f.orchestrator();
    const kinds = await artifactKinds(orchestrator, runId);
    expect(kinds).toContain("testing-execution-completion");
    const changeSet = kinds.find((kind) => kind.startsWith("testing-change-set-"));
    if (changeSet === undefined) throw new Error("SMOKE_CHANGE_SET_ABSENT");
    expect(JSON.stringify(await readArtifact(orchestrator, runId, changeSet))).toContain("session version");
    expect(f.provider.checks()).toBeGreaterThan(0);
    // Write authority reached only the disposable worktree; the checkout is unchanged.
    expect(await readFile(join(f.root, "test", "session.test.ts"), "utf8")).toBe(`${SMOKE_TEST}\n`);
    const workspace = await readArtifact(orchestrator, runId, "testing-workspace").catch(() => undefined) as { handle?: TestingWorktreeHandle } | undefined;
    if (workspace?.handle !== undefined) await TestingWorktree.recover(workspace.handle);
    for (const call of f.provider.calls) exercised.add(call.protocol);
  }, 60_000);

  it("exercised all four wire protocols across the templates", () => {
    expect([...exercised].sort()).toEqual(["anthropic-messages", "gemini-native", "openai-chat", "openai-responses"]);
  });
});
