import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { orchestratorCore } from "../src/cli-core.js";
import { configurationDiagnostics, environmentDiagnostics, PreflightError, type PreflightDiagnostic } from "../src/preflight.js";
import { DockerTestSandbox, type BoundedProcessResult, type ProcessRequest, type SandboxAvailability } from "../src/test-sandbox.js";
import { smokeProvider, smokeRepository } from "./smoke-provider.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function template(name: string): Promise<RunConfig> {
  return runConfigSchema.parse(JSON.parse(await readFile(new URL(`../../../examples/model-backed/${name}.json`, import.meta.url), "utf8")));
}
const codes = (diagnostics: readonly PreflightDiagnostic[]) => diagnostics.filter(({ severity }) => severity === "error").map(({ code }) => code);
const present = () => "set";
const absent = () => undefined;
const sandbox = (availability: SandboxAvailability) => ({ async inspect() { return availability; } });
type Mutable = Record<string, unknown> & { workflow: Record<string, unknown>; models: Record<string, Record<string, unknown>> };
const mutable = (config: RunConfig): Mutable => structuredClone(config) as unknown as Mutable;
const execution = (config: Mutable) => config.workflow["modelExecution"] as Record<string, unknown>;
const testing = (config: Mutable) => (config.workflow["testing"] as { execution: { authorization: { partitions: { id: string; paths: string[] }[] }; verification: { execution: Record<string, unknown> } } });

describe("configuration preflight", () => {
  it.each(["audit-mixed-providers", "audit-compatible-chat", "feature-interactive", "feature-automatic", "testing-plan", "testing-execute"])("accepts the shipped %s template", async (name) => {
    expect(codes(configurationDiagnostics(await template(name)))).toEqual([]);
  });

  it("names missing Audit roles and the preset's auditor profiles", async () => {
    const config = mutable(await template("audit-mixed-providers"));
    delete execution(config)["roles"];
    expect(codes(configurationDiagnostics(config as unknown as RunConfig))).toEqual(["MODEL_EXECUTION_ROLES_REQUIRED"]);
    execution(config)["roles"] = { planner: "auditor-a", verifier: "auditor-b" };
    const critic = configurationDiagnostics(config as unknown as RunConfig);
    expect(critic).toEqual([expect.objectContaining({ code: "MODEL_CRITIC_PROFILE_REQUIRED", path: "workflow.modelExecution.roles.critic" })]);
    const balanced = mutable(await template("audit-compatible-chat"));
    balanced.workflow["preset"] = "audit-deep";
    execution(balanced)["roles"] = { planner: "auditor-a", verifier: "auditor-b", critic: "auditor-b" };
    expect(configurationDiagnostics(balanced as unknown as RunConfig)).toEqual([expect.objectContaining({ code: "MODEL_PROFILE_REQUIRED:auditor-c", path: "models.auditor-c" })]);
    delete balanced.workflow["modelExecution"];
    expect(codes(configurationDiagnostics(balanced as unknown as RunConfig))).toEqual(["RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED"]);
  });

  it("rejects native harness mode with the canonical alternative", async () => {
    const config = mutable(await template("feature-automatic"));
    config["harness"] = { mode: "native" };
    const [diagnostic] = configurationDiagnostics(config as unknown as RunConfig);
    expect(diagnostic).toMatchObject({ code: "RUNTIME_NATIVE_HARNESS_NOT_AVAILABLE", path: "harness.mode" });
    expect(diagnostic?.message).toContain("canonical");
  });

  it("reports missing capabilities: frontier analyst, writer tools and tier, unsupported effort", async () => {
    const config = mutable(await template("testing-execute"));
    const analyst = config.models["analyst"]; const writer = config.models["writer"];
    if (analyst === undefined || writer === undefined) throw new Error("TEMPLATE_PROFILE_ABSENT");
    analyst["capabilityTier"] = "balanced";
    writer["supports"] = { ...(writer["supports"] as object), tools: false };
    writer["capabilityTier"] = "fast";
    writer["effort"] = { supported: ["medium"], collapse: {}, params: {} };
    analyst["effort"] = { supported: ["medium"], collapse: {}, params: {} };
    const diagnostics = configurationDiagnostics(config as unknown as RunConfig);
    expect(codes(diagnostics)).toEqual(expect.arrayContaining(["TESTING_FRONTIER_ANALYST_REQUIRED", "TESTING_TASK_MODEL_CONFIGURATION_INVALID", "MODEL_EFFORT_UNSUPPORTED:analyst"]));
    // Writer effort follows the plan's routing, so an unsupported level is only a warning.
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "MODEL_EFFORT_UNSUPPORTED:writer", severity: "warning", path: "models.writer.effort" }));
    expect(diagnostics.find(({ message }) => message.includes("supports.tools"))?.path).toBe("workflow.testing.execution.models.fast");
    expect(diagnostics.some(({ code, path }) => code === "TESTING_TASK_MODEL_CONFIGURATION_INVALID" && path === "workflow.testing.execution.models.balanced")).toBe(true);
  });

  it("requires independent Feature reviewers and critic", async () => {
    const config = mutable(await template("feature-interactive"));
    const reviewer = config.models["reviewer-gemini"]; if (reviewer === undefined) throw new Error("TEMPLATE_PROFILE_ABSENT");
    reviewer["independenceGroup"] = "anthropic";
    (config.workflow["feature"] as { roles: Record<string, unknown> }).roles["critic"] = "planner";
    expect(codes(configurationDiagnostics(config as unknown as RunConfig))).toEqual(["FEATURE_REVIEW_INDEPENDENCE_REQUIRED", "FEATURE_CRITIC_INDEPENDENCE_REQUIRED"]);
  });

  it("refuses write grants that are not exact, verifiable test paths", async () => {
    const config = mutable(await template("testing-execute"));
    testing(config).execution.authorization.partitions[0] = { id: "tests", paths: ["test/**", ".git/config", "test/other.test.ts"] };
    const diagnostics = configurationDiagnostics(config as unknown as RunConfig);
    expect(codes(diagnostics).filter((code) => code === "TESTING_WRITE_PATH_INVALID")).toHaveLength(2);
    expect(diagnostics.some(({ message }) => message.startsWith("CONTROL_PLANE_WRITE_FORBIDDEN"))).toBe(true);
    expect(diagnostics.filter(({ code }) => code === "TESTING_WRITE_WITHOUT_VERIFICATION_CHECK").map(({ message }) => message.split(" ")[0])).toEqual(["test/**", ".git/config", "test/other.test.ts"]);
  });

  it("explains an unpinned sandbox image and absent execution authority through the schema", async () => {
    const config = mutable(await template("testing-execute"));
    testing(config).execution.verification.execution["image"] = "node:22";
    const unpinned = runConfigSchema.safeParse(config);
    expect(unpinned.success).toBe(false);
    expect(unpinned.error?.issues.map(({ message }) => message).join()).toContain("pinned by digest");
    const withoutAuthority = mutable(await template("testing-execute"));
    delete (withoutAuthority.workflow["testing"] as Record<string, unknown>)["execution"];
    expect(runConfigSchema.safeParse(withoutAuthority).error?.issues.some(({ path }) => path.join(".") === "workflow.testing.execution")).toBe(true);
  });
});

describe("environment preflight", () => {
  it("names each unset credential variable without reading or echoing values", async () => {
    const config = await template("audit-mixed-providers");
    const seen: string[] = [];
    const diagnostics = await environmentDiagnostics(config, { credential: (name) => { seen.push(name); return name === "ARBITRA_OPENAI_API_KEY" ? "value-never-reported" : undefined; } });
    expect(codes(diagnostics)).toEqual(["PROVIDER_CREDENTIAL_MISSING:anthropic", "PROVIDER_CREDENTIAL_MISSING:gemini"]);
    expect(diagnostics[0]?.message).toContain("ARBITRA_ANTHROPIC_API_KEY");
    expect(JSON.stringify(diagnostics)).not.toContain("value-never-reported");
    expect(seen.sort()).toEqual(["ARBITRA_ANTHROPIC_API_KEY", "ARBITRA_GEMINI_API_KEY", "ARBITRA_OPENAI_API_KEY"]);
  });

  it("refuses live dispatch of template placeholder model identities", async () => {
    const config = await template("testing-plan");
    expect(codes(await environmentDiagnostics(config, { credential: present, liveDispatch: true }))).toEqual(["MODEL_IDENTITY_PLACEHOLDER:analyst", "MODEL_IDENTITY_PLACEHOLDER:planner"]);
    expect(codes(await environmentDiagnostics(config, { credential: present, liveDispatch: false }))).toEqual([]);
  });

  it("requires the Docker engine and pinned image for Testing execution but only warns for Audit checks", async () => {
    const execute = await template("testing-execute");
    expect(codes(await environmentDiagnostics(execute, { credential: present, sandbox: sandbox({ engine: "unavailable", image: "unknown", detail: "docker executable not found on PATH" }) }))).toEqual(["SANDBOX_ENGINE_UNAVAILABLE"]);
    const missing = await environmentDiagnostics(execute, { credential: present, sandbox: sandbox({ engine: "available", image: "absent", detail: null }) });
    expect(codes(missing)).toEqual([`SANDBOX_IMAGE_UNAVAILABLE:replace-with-your-local-test-image@sha256:${"0".repeat(64)}`]);
    expect(missing[0]?.message).toContain("never pulls");
    const audit = mutable(await template("audit-compatible-chat"));
    audit["verification"] = { execution: { driver: "docker", image: `local/node@sha256:${"a".repeat(64)}`, checks: [{ id: "unit", sourcePaths: ["src/session.ts"], executable: "/usr/local/bin/node", arguments: ["--test"] }] } };
    const unavailable = sandbox({ engine: "unavailable", image: "unknown", detail: null });
    const warnings = await environmentDiagnostics(audit as unknown as RunConfig, { credential: present, sandbox: unavailable });
    expect(warnings).toEqual([expect.objectContaining({ code: "SANDBOX_ENGINE_UNAVAILABLE", severity: "warning" })]);
    expect(await environmentDiagnostics(audit as unknown as RunConfig, { credential: present, sandbox: unavailable, includeWarnings: false })).toEqual([]);
  });

  it("inspects only the local Docker image store, never pulling", async () => {
    const image = `local/node@sha256:${"a".repeat(64)}`;
    const requests: ProcessRequest[] = [];
    const result = (value: Partial<BoundedProcessResult>): BoundedProcessResult => ({ exitCode: 0, stdout: "", stderr: "", stopped: null, ...value });
    const probe = (image: "present" | "absent") => new DockerTestSandbox({ async run(request) {
      requests.push(request);
      if (request.arguments[2] === "info") return result({ stdout: "linux\n" });
      return image === "present" ? result({ stdout: "sha256:abc" }) : result({ exitCode: 1, stderr: `Error: No such image: ${String(request.arguments.at(-1))}\n` });
    } });
    await expect(probe("present").inspect(image, new AbortController().signal)).resolves.toEqual({ engine: "available", image: "present", detail: null });
    await expect(probe("absent").inspect(image, new AbortController().signal)).resolves.toMatchObject({ engine: "available", image: "absent", detail: expect.stringContaining("No such image") });
    expect(requests.map(({ arguments: args }) => args.slice(2))).toEqual([["info", "--format", "{{.OSType}}"], ["image", "inspect", "--format", "{{.Id}}", image], ["info", "--format", "{{.OSType}}"], ["image", "inspect", "--format", "{{.Id}}", image]]);
    expect(requests.every(({ arguments: args, environment }) => !args.includes("pull") && !("DOCKER_HOST" in environment))).toBe(true);
    const missing = new DockerTestSandbox({ async run() { return result({ exitCode: null, stopped: "spawn_error" }); } });
    await expect(missing.inspect(image, new AbortController().signal)).resolves.toEqual({ engine: "unavailable", image: "unknown", detail: "docker executable not found on PATH" });
    await expect(missing.inspect("node:22", new AbortController().signal)).rejects.toThrow();
  });
});

describe("public runtime preflight", () => {
  async function repository() {
    const root = await mkdtemp(join(tmpdir(), "arbitra-preflight-")); roots.push(root);
    await smokeRepository(root);
    return root;
  }

  it("fails before creating a run when a credential is missing, and dispatches nothing", async () => {
    const root = await repository();
    const provider = await smokeProvider();
    const core = new Orchestrator({ repository: root, stateDirectory: join(root, ".runs"), providerOptions: { ...provider.providerOptions, credential: absent }, testSandbox: provider.sandbox });
    const failure = await core.start(await template("feature-automatic")).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(PreflightError);
    expect((failure as PreflightError).statusCode).toBe(400);
    expect((failure as Error).message).toContain("PROVIDER_CREDENTIAL_MISSING:anthropic at workflow.modelExecution.endpoints.0.apiKeyEnvVar");
    expect(provider.calls).toHaveLength(0);
    await expect(readdir(join(root, ".runs", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a live run of an unedited template before any network request", async () => {
    const root = await repository();
    // No injected client: this is the production HTTP path, which must not be reached.
    const core = new Orchestrator({ repository: root, stateDirectory: join(root, ".runs"), providerOptions: { credential: present } });
    await expect(core.start(await template("testing-plan"))).rejects.toThrow("MODEL_IDENTITY_PLACEHOLDER:analyst");
  });

  it("reports configuration validity and environment readiness separately through the CLI core", async () => {
    const root = await repository();
    const core = orchestratorCore(new Orchestrator({ repository: root, stateDirectory: join(root, ".runs"), providerOptions: { credential: absent }, testSandbox: { ...(await smokeProvider()).sandbox, ...sandbox({ engine: "available", image: "absent", detail: null }) } }));
    const path = join(root, "execute.json");
    await writeFile(path, await readFile(new URL("../../../examples/model-backed/testing-execute.json", import.meta.url), "utf8"));
    const validation = await core.validate(path);
    expect(validation).toMatchObject({ disposition: "passed", reasons: [], value: { valid: true, ready: false, mode: "testing", preset: "testing-execute", modelBacked: true } });
    expect(codes((validation.value as { diagnostics: PreflightDiagnostic[] }).diagnostics)).toEqual(expect.arrayContaining(["MODEL_IDENTITY_PLACEHOLDER:analyst", "PROVIDER_CREDENTIAL_MISSING:anthropic", "PROVIDER_CREDENTIAL_MISSING:openai", `SANDBOX_IMAGE_UNAVAILABLE:replace-with-your-local-test-image@sha256:${"0".repeat(64)}`]));
    const run = await core.run(path);
    expect(run.disposition).toBe("system_failure");
    expect(run.reasons).toEqual(expect.arrayContaining(["preflight_failed", "PROVIDER_CREDENTIAL_MISSING:openai"]));
    const native = join(root, "native.json");
    await writeFile(native, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")) as object, harness: { mode: "native" } }));
    expect(await core.validate(native)).toMatchObject({ disposition: "failed", reasons: ["invalid_configuration", "RUNTIME_NATIVE_HARNESS_NOT_AVAILABLE"], value: { valid: false } });
    const secret = join(root, "secret.json");
    await writeFile(secret, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")) as object, budgets: { apiKey: "not-a-real-key" } }));
    const rejected = await core.validate(secret);
    expect(rejected).toMatchObject({ disposition: "failed", value: { valid: false, diagnostics: [{ code: "RESOLVED_CREDENTIAL_FORBIDDEN" }] } });
    expect(JSON.stringify(rejected)).not.toContain("not-a-real-key");
  });

  it("classifies a scripted Audit as not model-backed and needing no credentials", async () => {
    const root = await repository();
    const report = await new Orchestrator({ repository: root, providerOptions: { credential: absent } }).preflight(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")) as unknown);
    // The schema-only examples declare placeholder profiles but no modelExecution.
    expect(report).toMatchObject({ valid: false, modelBacked: true });
    expect(codes(report.diagnostics)).toContain("RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED");
    const scripted = await new Orchestrator({ repository: root, providerOptions: { credential: absent } }).preflight({ ...(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")) as object), models: {} });
    expect(scripted).toMatchObject({ valid: true, ready: true, modelBacked: false, diagnostics: [] });
  });
});

describe("advisor preflight", () => {
  it("reports advisor tiers that name under-tier or unbound profiles", async () => {
    const config = mutable(await template("testing-execute"));
    const execute = config.workflow["testing"] as { execution: Record<string, unknown> };
    const policy = { maximumUsesPerTask: 1, maximumContextTokens: 4000, maximumOutputTokens: 500, maximumTokensPerTask: 8000 };
    execute.execution["advisors"] = { ...policy, models: { frontier: "writer" } };
    expect(configurationDiagnostics(config as unknown as RunConfig)).toContainEqual(expect.objectContaining({ code: "ADVISOR_MODEL_CONFIGURATION_INVALID", path: "workflow.testing.execution.advisors" }));
    const analyst = config.models["analyst"]; if (analyst === undefined) throw new Error("TEMPLATE_PROFILE_ABSENT");
    config.models["advisor"] = { ...analyst };
    execute.execution["advisors"] = { ...policy, models: { frontier: "advisor" } };
    expect(configurationDiagnostics(config as unknown as RunConfig)).toContainEqual(expect.objectContaining({ code: "ADVISOR_MODEL_ENDPOINT_ABSENT:advisor", path: "workflow.testing.execution.advisors.models.frontier" }));
    delete config.models["advisor"];
    execute.execution["advisors"] = { ...policy, models: { frontier: "analyst" } };
    expect(codes(configurationDiagnostics(runConfigSchema.parse(config)))).toEqual([]);
  });
});
