import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { buildServer } from "../src/main.js";

describe("real HTTP runtime integration", () => {
  it("saves a configuration, streams a completed run, and reads redacted durable artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-http-integration-"));
    const orchestrator = new Orchestrator({ repository: root });
    const app = buildServer(controlPlaneCore(orchestrator));
    try {
      await writeFile(join(root, "source.ts"), "export const value = true;\n");
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const request = (path: string, body?: unknown) => fetch(`${address}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      const savedResponse = await request("/configurations", { name: "Smoke", config: {
        schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced",
        consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {},
        harness: { mode: "canonical" }, workflow: { preset: "audit-balanced" }, budgets: {},
        security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {},
      } });
      expect(savedResponse.status).toBe(200);
      const saved = await savedResponse.json() as { id: string };
      const startedResponse = await request("/runs", { configurationId: saved.id });
      expect(startedResponse.status).toBe(200);
      const started = await startedResponse.json() as { runId: string };
      const stream = await request(`/runs/${started.runId}/events`);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const frames = await stream.text();
      expect(frames).toContain('"state":"COMPLETED"');
      expect(frames.endsWith("event: end\ndata: {}\n\n")).toBe(true);
      const resource = await (await request(`/runs/${started.runId}`)).json();
      expect(resource).toMatchObject({ runId: started.runId, state: "COMPLETED", resumable: false, workflow: { id: "audit-balanced" } });
      const artifacts = await (await request(`/runs/${started.runId}/artifacts`)).json() as Array<{ artifactId: string; kind: string; redacted: boolean }>;
      expect(artifacts.every(({ redacted }) => redacted)).toBe(true);
      const canonical = artifacts.find(({ kind }) => kind === "canonical-issues");
      if (canonical === undefined) throw new Error("canonical issues missing");
      const artifact = await (await request(`/runs/${started.runId}/artifacts/${encodeURIComponent(canonical.artifactId)}`)).json() as { content: string };
      expect(JSON.parse(artifact.content)).toMatchObject({ summary: { auditorCount: 2 } });
      expect(await new Orchestrator({ repository: root }).status(started.runId)).toMatchObject({ state: "COMPLETED" });
      await expect(orchestrator.resume(started.runId)).rejects.toThrow("RUN_NOT_RESUMABLE");
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("lists runs with their gate, reads a run's stored settings, and preflights an unsaved configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-http-overview-"));
    const orchestrator = new Orchestrator({ repository: root });
    const app = buildServer(controlPlaneCore(orchestrator));
    const config = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {},
      harness: { mode: "canonical" }, workflow: { preset: "audit-balanced" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
    try {
      await writeFile(join(root, "source.ts"), "export const value = true;\n");
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const request = (path: string, body?: unknown) => fetch(`${address}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      expect(await (await request("/runs")).json()).toEqual([]);
      expect(await (await request("/repositories/selected")).json()).toEqual({ repository: root });

      // Preflight reads an unsaved configuration: nothing is saved and no run exists afterwards.
      const checked = await (await request("/preflight", { config })).json();
      expect(checked).toMatchObject({ valid: true, ready: true, mode: "audit", preset: "audit-balanced", modelBacked: false, repository: root, estimateError: null,
        estimate: { estimate: { files: 1, providerCalls: 0, costUsd: 0, basis: "scripted_auditors_make_no_provider_calls" }, gate: "clear" } });
      expect(await (await request("/configurations")).json()).toEqual([]);
      const invalid = await (await request("/preflight", { config: { mode: "audit" } })).json() as { valid: boolean; estimate: unknown; diagnostics: unknown[] };
      expect(invalid).toMatchObject({ valid: false, estimate: null });
      expect(invalid.diagnostics.length).toBeGreaterThan(0);
      const missing = await request("/preflight", { config, repository: join(root, "absent") });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ message: `REPOSITORY_NOT_FOUND:${join(root, "absent")}` });

      const saved = await (await request("/configurations", { name: "Smoke", config })).json() as { id: string };
      const started = await (await request("/runs", { configurationId: saved.id })).json() as { runId: string };
      await (await request(`/runs/${started.runId}/events`)).text();
      const listed = await (await request("/runs")).json() as { createdAt: string; updatedAt: string }[];
      expect(listed).toEqual([expect.objectContaining({ runId: started.runId, state: "COMPLETED", reason: null, mode: "audit", workflowId: "audit-balanced", repository: root, executor: "scripted",
        replayOf: null, pendingDecisions: 0, gate: { status: "failed", reasons: expect.arrayContaining(["degraded_coverage"]) }, problem: null })]);
      expect(Date.parse(listed[0]?.createdAt ?? "")).toBeLessThanOrEqual(Date.parse(listed[0]?.updatedAt ?? ""));
      // A finished run is not executed by this process, and its entry is reused until its files change.
      expect(listed[0]).toMatchObject({ live: false });
      const [first] = await orchestrator.listRuns();
      const [second] = await orchestrator.listRuns();
      expect(second).toBe(first);
      // The public gate and the listed gate are the same verdict.
      const gate = await orchestrator.gate(started.runId);
      expect(listed[0]).toMatchObject({ gate: { status: gate.gateStatus, reasons: gate.reasons } });
      expect(await (await request(`/runs/${started.runId}/overview`)).json()).toMatchObject({ runId: started.runId, scope: { kind: "repository" }, consensusPolicy: "risk_weighted",
        maximumRounds: 2, checkpointMode: null, workflowGraph: null, configuration: null });
      expect((await request("/runs/run-absent/overview")).status).toBe(404);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
