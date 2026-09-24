import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { buildServer } from "../src/main.js";

it("validates and forwards proposal application through the public requirements route", async () => {
  const root = await mkdtemp(join(tmpdir(), "requirements-proposal-http-"));
  const core = controlPlaneCore(new Orchestrator({ repository: root }));
  const calls: string[][] = [];
  const app = buildServer({ ...core, requirements: { ...core.requirements, async applyRevision(runId, artifactId) { calls.push([runId, artifactId]); return { artifactId: "new-contract", pendingAmbiguityIds: ["migration"] }; } } });
  try {
    for (const payload of [{}, { artifactId: 1 }, { artifactId: "proposal", decision: "approve" }]) {
      expect((await app.inject({ method: "POST", url: "/runs/run-1/requirements/apply-revision", payload })).statusCode).toBe(400);
    }
    const applied = await app.inject({ method: "POST", url: "/runs/run-1/requirements/apply-revision", payload: { artifactId: "proposal-1" } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ artifactId: "new-contract", pendingAmbiguityIds: ["migration"] });
    expect(calls).toEqual([["run-1", "proposal-1"]]);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

it("edits durable requirements through strict HTTP routes and rejects stale approval after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "feature-http-"));
  const draft = { assumptions: [{ id: "assumption", statement: "Keep sessions", confidence: "high" }], ambiguities: [{ id: "migration", question: "Migrate?", proposedDefault: "Keep", blastRadius: "high" }], acceptance: [{ id: "acceptance", assertion: "New sessions work" }], outOfScope: [] };
  let calls = 0;
  const providerOptions = { credential: () => "fixture-credential", client: { async send() { calls += 1; return { status: 200, headers: {}, body: { output_text: JSON.stringify(draft), usage: { input_tokens: 20, output_tokens: 30 } } }; } } };
  const orchestrator = new Orchestrator({ repository: root, providerOptions });
  const app = buildServer(controlPlaneCore(orchestrator));
  try {
    await writeFile(join(root, "session.ts"), "export const version = 1;\n");
    const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
    const profile = example.models["auditor-a"]; if (profile === undefined) throw new Error("PROFILE_ABSENT");
    const config = runConfigSchema.parse({ ...example, mode: "feature", scope: { kind: "repository" }, models: { requirements: profile }, workflow: {
      preset: "feature-simple", feature: { request: "Add session preferences", mode: "interactive", roles: { requirements: "requirements", exploration: "requirements", planner: "requirements", reviewers: [] } },
      modelExecution: { endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }], modelEndpoints: { requirements: "primary" }, maximumOutputTokens: 2000, maximumTokens: 1000000, maximumRetries: 0, timeoutMs: 2000, rateLimits: { [profile.provider]: { rpm: 100, tpm: 1000000, maxConcurrent: 4 } } },
    } });
    const saved = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Feature", config } });
    expect(saved.statusCode, saved.body).toBe(200);
    const started = await app.inject({ method: "POST", url: "/runs", payload: { configurationId: saved.json<{ id: string }>().id } });
    expect(started.statusCode).toBe(200);
    const { runId } = started.json<{ runId: string }>();
    expect((await orchestrator.wait(runId)).state).toBe("BLOCKED");
    const current = await app.inject({ method: "GET", url: `/runs/${runId}/requirements` });
    const original = current.json<{ artifactId: string }>(); expect(current.statusCode).toBe(200);
    const invalid = await app.inject({ method: "POST", url: `/runs/${runId}/requirements/approve`, payload: { artifactId: original.artifactId } });
    expect(invalid.statusCode).toBe(400);
    const revised = await app.inject({ method: "POST", url: `/runs/${runId}/requirements/revise`, payload: { artifactId: original.artifactId, draft: { ...draft, ambiguities: [{ ...draft.ambiguities[0], proposedDefault: "Expire" }] } } });
    expect(revised.statusCode).toBe(200);
    const next = revised.json<{ artifactId: string }>(); expect(next.artifactId).not.toBe(original.artifactId);
    const restarted = buildServer(controlPlaneCore(new Orchestrator({ repository: root, providerOptions })));
    try {
      const stale = await restarted.inject({ method: "POST", url: `/runs/${runId}/requirements/approve`, payload: { artifactId: original.artifactId, ambiguityIds: ["migration"] } });
      expect(stale.statusCode).toBe(409);
      const approved = await restarted.inject({ method: "POST", url: `/runs/${runId}/requirements/approve`, payload: { artifactId: next.artifactId, ambiguityIds: ["migration"] } });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ pendingAmbiguityIds: [], contract: { decision: { acceptedDefaults: [{ value: "Expire", acceptedBy: "operator" }] } } });
      expect(calls).toBe(1);
    } finally { await restarted.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

it("returns actionable preflight failures as 400 before creating a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "preflight-http-"));
  let calls = 0;
  const orchestrator = new Orchestrator({ repository: root, providerOptions: { credential: () => undefined, client: { async send() { calls += 1; throw new Error("UNEXPECTED_PROVIDER_CALL"); } } } });
  const app = buildServer(controlPlaneCore(orchestrator));
  try {
    await writeFile(join(root, "session.ts"), "export const version = 1;\n");
    const config = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/model-backed/feature-automatic.json", import.meta.url), "utf8")));
    const saved = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Feature", config } });
    expect(saved.statusCode, saved.body).toBe(200);
    const started = await app.inject({ method: "POST", url: "/runs", payload: { configurationId: saved.json<{ id: string }>().id } });
    expect(started.statusCode).toBe(400);
    expect(started.json<{ message: string }>().message).toContain("PROVIDER_CREDENTIAL_MISSING:anthropic at workflow.modelExecution.endpoints.0.apiKeyEnvVar: Environment variable ARBITRA_ANTHROPIC_API_KEY is not set");
    expect(calls).toBe(0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
