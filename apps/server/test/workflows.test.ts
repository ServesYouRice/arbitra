import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HTTP_ROUTE_SCHEMAS } from "@arbitra/schemas/http-control-plane";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { buildServer } from "../src/main.js";
import { registerWorkflowRoutes, WORKFLOW_ROUTE_INVENTORY } from "../src/routes/workflows.js";

interface Graph { id: string; nodes: { id: string; kind: string; label: string; goal: unknown; config?: unknown }[]; edges: { id: string; from: string; to: string }[] }
const config = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "fast", consensusPolicy: "minimal", maxConsensusRounds: 1, verification: {}, models: {}, harness: { mode: "canonical" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };

describe("workflow graph routes", () => {
  it("registers every route with its canonical schema", () => {
    const routes: string[] = [];
    registerWorkflowRoutes({ route: ({ method, url }) => { routes.push(`${method} ${url}`); } }, { list: async () => null, versions: async () => null, version: async () => null, validate: async () => null, save: async () => null }, HTTP_ROUTE_SCHEMAS);
    expect(routes).toEqual(WORKFLOW_ROUTE_INVENTORY.map(([method, url]) => `${method} ${url}`));
    expect(() => registerWorkflowRoutes({ route: () => undefined }, { list: async () => null, versions: async () => null, version: async () => null, validate: async () => null, save: async () => null }, {})).toThrow("MISSING_HTTP_SCHEMA");
  });

  it("validates, saves immutable versions and dispatches the saved version over HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflows-http-"));
    const repository = join(root, "repository");
    const options = { repository, stateDirectory: join(root, "state") };
    const app = buildServer(controlPlaneCore(new Orchestrator(options)));
    try {
      await mkdir(repository, { recursive: true });
      await writeFile(join(repository, "index.ts"), "export const value = 1;\n");
      const listed = await app.inject({ method: "GET", url: "/workflows" });
      expect(listed.statusCode).toBe(200);
      const { graphs, templates } = listed.json<{ graphs: unknown[]; templates: Graph[] }>();
      expect(graphs).toEqual([]);
      const template = templates.find(({ id }) => id === "diff-review");
      if (template === undefined) throw new Error("TEMPLATE_ABSENT");
      const edge = (id: string, from: string, to: string) => ({ ...template.edges[0], id, from, to });
      const graph: Graph = {
        ...template, id: "http-reviewed",
        nodes: [...template.nodes, { id: "signoff", kind: "human", label: "Sign-off <b>now</b>", goal: { objective: "Sign off", doneWhen: [], stopWhen: [], blockedWhen: [] } }],
        edges: [...template.edges.filter(({ id }) => id !== "verification-planner"), edge("v-s", "verification", "signoff"), edge("s-p", "signoff", "planner")],
      };

      // Validation is the server's and reports stable codes; nothing is written.
      const cyclic = await app.inject({ method: "POST", url: "/workflows/validate", payload: { graph: { ...graph, edges: [...graph.edges, edge("back", "planner", "preflight")] } } });
      expect(cyclic.statusCode).toBe(200);
      expect(cyclic.json()).toMatchObject({ valid: false, configurationChecked: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "UNBOUNDED_CYCLE" }), expect.objectContaining({ code: "EDGE_INTO_ENTRY" })]) });
      const preset = await app.inject({ method: "POST", url: "/workflows", payload: { graph: template } });
      expect(preset.statusCode).toBe(422);
      expect(preset.json()).toMatchObject({ message: "WORKFLOW_GRAPH_INVALID:UNAUTHORIZED_CHANGE" });
      expect((await app.inject({ method: "POST", url: "/workflows", payload: { graph, force: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/workflows", payload: { graph, authorize: ["root"] } })).statusCode).toBe(400);

      const noPolicy = await app.inject({ method: "POST", url: "/configurations", payload: { name: "No policy", config: { ...config, workflow: {} } } });
      const checked = await app.inject({ method: "POST", url: "/workflows/validate", payload: { graph, configurationId: noPolicy.json<{ id: string }>().id } });
      expect(checked.json()).toMatchObject({ valid: false, configurationChecked: true, diagnostics: [expect.objectContaining({ code: "CHECKPOINT_POLICY_REQUIRED", path: "nodes[6](signoff)" })] });

      const saved = await app.inject({ method: "POST", url: "/workflows", payload: { graph } });
      expect(saved.statusCode, saved.body).toBe(200);
      const { record } = saved.json<{ record: { version: string; graph: Graph } }>();
      expect(record.graph).toEqual(graph);
      expect((await app.inject({ method: "GET", url: "/workflows/http-reviewed" })).json()).toMatchObject({ graphId: "http-reviewed", versions: [{ version: record.version, parentVersion: null }] });
      expect((await app.inject({ method: "GET", url: `/workflows/http-reviewed/versions/${record.version}` })).json()).toEqual(record);
      expect((await app.inject({ method: "GET", url: "/workflows/http-reviewed/versions/latest" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/workflows/http-reviewed/versions/${"0".repeat(64)}` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/workflows/absent" })).statusCode).toBe(404);

      const missing = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Missing", config: { ...config, workflow: { graph: { id: "http-reviewed", version: "0".repeat(64) }, checkpoints: { mode: "interactive" } } } } });
      const refused = await app.inject({ method: "POST", url: "/runs", payload: { configurationId: missing.json<{ id: string }>().id } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ message: string }>().message).toMatch(/^WORKFLOW_GRAPH_VERSION_ABSENT at workflow.graph: Saved graph http-reviewed has no version 0{64}/u);

      const runnable = await app.inject({ method: "POST", url: "/configurations", payload: { name: "Reviewed", config: { ...config, workflow: { graph: { id: "http-reviewed", version: record.version }, checkpoints: { mode: "interactive" } } } } });
      const started = await app.inject({ method: "POST", url: "/runs", payload: { configurationId: runnable.json<{ id: string }>().id } });
      expect(started.statusCode, started.body).toBe(200);
      const { runId } = started.json<{ runId: string }>();
      let status = await app.inject({ method: "GET", url: `/runs/${runId}` });
      for (let attempt = 0; status.json<{ state: string }>().state !== "BLOCKED" && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = await app.inject({ method: "GET", url: `/runs/${runId}` });
      }
      expect(status.json()).toMatchObject({ state: "BLOCKED", workflowGraph: { id: "http-reviewed", version: record.version, executedVersion: record.version }, workflow: graph, checkpoints: [{ checkpointId: "signoff", prompt: "Sign-off <b>now</b>" }] });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
