import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { orchestratorCore } from "../src/cli-core.js";
import { TestingWorktree, type TestingWorktreeHandle } from "../src/testing-worktree.js";
import { SMOKE_SOURCE, SMOKE_TEST, smokeProvider, smokeRepository, type WireProtocol } from "./smoke-provider.js";

/**
 * Credential-free smoke checks of every shipped subscription template, unmodified, through
 * the public CLI core and orchestrator. The subscription CLIs are replaced by an in-process
 * runner that speaks each CLI's event format, so configuration, preflight (installed,
 * version, login), prompt serialization, emulated tool calls and durable stages are
 * exercised with no login, network or model. It proves wiring, not model quality.
 */
const TEMPLATES = new URL("../../../examples/model-backed/", import.meta.url);
const roots: string[] = [];
const exercised = new Set<WireProtocol>();
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(name: string, options: { highImpactAmbiguity?: boolean; edit?: (config: Record<string, unknown>) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), `arbitra-subscription-smoke-${name}-`)); roots.push(root);
  const repository = join(root, "repo");
  await smokeRepository(repository);
  const configPath = join(root, `${name}.json`);
  const config = JSON.parse(await readFile(new URL(`${name}.json`, TEMPLATES), "utf8")) as Record<string, unknown>;
  options.edit?.(config);
  await writeFile(configPath, JSON.stringify(config));
  const provider = await smokeProvider({ ...options, root });
  const orchestrator = () => new Orchestrator({ repository, stateDirectory: join(repository, ".runs"), providerOptions: provider.providerOptions, testSandbox: provider.sandbox });
  return { root: repository, configPath, provider, orchestrator, core: orchestratorCore(orchestrator()) };
}

const record = (calls: readonly { protocol: WireProtocol }[]) => { for (const call of calls) exercised.add(call.protocol); };

describe("subscription template smoke checks", () => {
  it("validates and runs Audit on three subscription CLIs to a durable plan", async () => {
    const f = await setup("subscription-audit");
    const validation = await f.core.validate(f.configPath);
    expect(validation.value).toMatchObject({ valid: true, ready: true, mode: "audit", modelBacked: true });
    const codes = (validation.value as { diagnostics: { code: string; severity: string }[] }).diagnostics;
    expect(codes.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(codes.map(({ code }) => code)).toContain("SUBSCRIPTION_CLI_AUTH_UNVERIFIED:gemini");
    const result = await f.core.run(f.configPath);
    const value = result.value as { runId: string; state: string };
    expect(value.state).toBe("COMPLETED");
    expect((await f.orchestrator().artifacts(value.runId)).map(({ kind }) => kind)).toContain("plan-ir");
    const protocols = new Set(f.provider.calls.map(({ protocol }) => protocol));
    expect([...protocols].sort()).toEqual(["claude-code-cli", "codex-cli", "gemini-cli"]);
    expect(await readFile(join(f.root, "src", "session.ts"), "utf8")).toBe(`${SMOKE_SOURCE}\n`);
    record(f.provider.calls);
  }, 120_000);

  it("mixes an API-key auditor with subscription auditors in one run", async () => {
    const f = await setup("subscription-audit", { edit: (config) => {
      const models = config["models"] as Record<string, Record<string, unknown>>;
      const execution = (config["workflow"] as { modelExecution: { endpoints: unknown[]; modelEndpoints: Record<string, string>; rateLimits: Record<string, unknown> } }).modelExecution;
      models["auditor-b"] = { ...models["auditor-b"], transport: "openai-responses" };
      execution.endpoints = [...execution.endpoints.filter((endpoint) => (endpoint as { id: string }).id !== "codex"),
        { id: "openai-api", providerId: "openai", transport: "openai-responses", endpoint: "https://api.openai.com/v1", apiKeyEnvVar: "ARBITRA_OPENAI_API_KEY" }];
      execution.modelEndpoints["auditor-b"] = "openai-api";
    } });
    const result = await f.core.run(f.configPath);
    expect((result.value as { state: string }).state).toBe("COMPLETED");
    expect(new Set(f.provider.calls.map(({ protocol }) => protocol))).toEqual(new Set(["claude-code-cli", "openai-responses", "gemini-cli"]));
  }, 120_000);

  it("pauses interactive Feature for approval, then resumes to a handoff", async () => {
    const f = await setup("subscription-feature-interactive", { highImpactAmbiguity: true });
    const blocked = await f.core.run(f.configPath);
    expect(blocked.disposition).toBe("suspended");
    const runId = (blocked.value as { runId: string }).runId;
    const requirements = await f.orchestrator().requirements(runId) as { artifactId: string };
    await f.core.approveRequirements(runId, requirements.artifactId, ["migration"]);
    expect(await orchestratorCore(f.orchestrator()).resume(runId)).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed" } });
    record(f.provider.calls);
  }, 120_000);

  it("runs automatic Feature", async () => {
    const f = await setup("subscription-feature-automatic");
    expect(await f.core.run(f.configPath)).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed" } });
    record(f.provider.calls);
  }, 120_000);

  it("plans tests", async () => {
    const f = await setup("subscription-testing-plan");
    expect(await f.core.run(f.configPath)).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed", summary: { outcome: { testsExecuted: false, selectedGaps: 1 } } } });
    record(f.provider.calls);
  }, 120_000);

  it("executes granted test writes through emulated tool calls in an isolated worktree", async () => {
    const f = await setup("subscription-testing-execute");
    const result = await f.core.run(f.configPath);
    expect(result).toMatchObject({ disposition: "passed", value: { state: "COMPLETED", gateStatus: "passed", summary: { execution: { passed: true } } } });
    const runId = (result.value as { runId: string }).runId;
    const orchestrator = f.orchestrator();
    const kinds = (await orchestrator.artifacts(runId)).map(({ kind }) => kind);
    expect(kinds.some((kind) => kind.startsWith("testing-change-set-"))).toBe(true);
    expect(f.provider.calls.filter(({ stage, protocol }) => stage === "testing-writer" && protocol.endsWith("-cli")).length).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(f.root, "test", "session.test.ts"), "utf8")).toBe(`${SMOKE_TEST}\n`);
    const descriptor = (await orchestrator.artifacts(runId)).find(({ kind }) => kind === "testing-workspace");
    const workspace = descriptor === undefined ? undefined : JSON.parse((await orchestrator.artifact(runId, descriptor.artifactId) as { content: string }).content) as { handle?: TestingWorktreeHandle };
    if (workspace?.handle !== undefined) await TestingWorktree.recover(workspace.handle);
    record(f.provider.calls);
  }, 120_000);

  it("exercised all three subscription CLIs across the templates", () => {
    expect([...exercised].sort()).toEqual(["claude-code-cli", "codex-cli", "gemini-cli"]);
  });
});
