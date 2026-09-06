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
});
