import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import type { WorkflowGraph } from "@arbitra/workflow/graph-schema.js";
import { authoredTemplates, defaultEdge, templateOf, validateAuthoredGraph, type AuthoredGraphOptions } from "../src/authored-graphs.js";
import { AUDIT_DEEP_GRAPH, PRESET_GRAPHS } from "../src/graphs.js";
import { Orchestrator } from "../src/orchestrator.js";

const goal = (objective: string) => ({ objective, doneWhen: [], stopWhen: [], blockedWhen: [] });
const baseConfig = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: {}, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
const config = (workflow: Record<string, unknown>) => runConfigSchema.parse({ ...baseConfig, workflow });
const options = (extra: Partial<AuthoredGraphOptions> = {}): AuthoredGraphOptions => ({ gatePolicies: { pass: async () => ({ passed: true, reasons: [] }) }, authorize: [], reservedIds: Object.keys(PRESET_GRAPHS), ...extra });
const codes = (graph: unknown, extra: Partial<AuthoredGraphOptions> = {}): string[] => validateAuthoredGraph(graph, options(extra)).diagnostics.map(({ code }) => code);

/** audit-deep with a human sign-off between verification and the planner, under a new ID. */
function reviewed(id = "reviewed-audit"): WorkflowGraph {
  const template = templateOf(AUDIT_DEEP_GRAPH);
  return {
    ...template, id,
    nodes: [...template.nodes.map((node) => node.kind === "loop" ? { ...node, maximum: 1 } : node), { id: "signoff", kind: "human", label: "Sign-off", goal: goal("Operator sign-off"), config: { prompt: "Plan the accepted issues?" } }],
    edges: [...template.edges.filter(({ id: edgeId }) => edgeId !== "verification-planner"), defaultEdge("verification-signoff", "verification", "signoff"), defaultEdge("signoff-planner", "signoff", "planner")],
  };
}

describe("authored graph validation", () => {
  it("accepts an edited Audit template and rejects its unchanged shipped preset ID by default", () => {
    expect(codes(reviewed())).toEqual([]);
    expect(authoredTemplates().map(({ id }) => id)).toEqual(["audit-deep", "audit-balanced", "diff-review", "diff-fast"]);
    for (const template of authoredTemplates()) expect(codes(template)).toEqual(["UNAUTHORIZED_CHANGE"]);
    expect(codes(templateOf(AUDIT_DEEP_GRAPH), { authorize: ["shipped_preset_id"] })).toEqual([]);
  });

  it("rejects schema errors, invalid edges, unbounded loops and broken stage contracts", () => {
    expect(codes({ ...reviewed(), nodes: [...reviewed().nodes, { id: "extra", kind: "advisor", label: "x", goal: goal("x") }] })).toContain("SCHEMA");
    const graph = reviewed();
    expect(codes({ ...graph, edges: [...graph.edges, defaultEdge("back", "planner", "consensus")] })).toEqual(expect.arrayContaining(["UNBOUNDED_CYCLE"]));
    expect(codes({ ...graph, edges: [...graph.edges, defaultEdge("self", "planner", "planner")] })).toEqual(["SELF_LOOP"]);
    expect(codes({ ...graph, edges: [...graph.edges, defaultEdge("dangling", "planner", "missing")] })).toContain("SCHEMA");
    expect(codes({ ...graph, nodes: graph.nodes.map((node) => node.kind === "loop" ? { ...node, maximum: 7 } : node) })).toEqual(["LOOP_BOUND_EXCEEDED"]);
    expect(codes({ ...graph, edges: graph.edges.filter(({ id }) => id !== "c-c") })).toEqual(expect.arrayContaining(["EDGE_CONTRACT_UNSATISFIED"]));
    expect(codes({ ...graph, nodes: [...graph.nodes, { id: "summariser", kind: "model", label: "Summariser", goal: goal("x") }], edges: [...graph.edges, defaultEdge("s", "planner", "summariser")] })).toEqual(["UNKNOWN_MODEL_ROLE"]);
    expect(codes({ ...graph, nodes: [...graph.nodes, { id: "gate", kind: "gate", label: "Gate", goal: goal("x") }], edges: [...graph.edges, defaultEdge("g", "planner", "gate")] })).toEqual(["GATE_POLICY_REQUIRED"]);
    expect(codes({ ...graph, nodes: [...graph.nodes, { id: "gate", kind: "gate", label: "Gate", goal: goal("x"), config: { policy: "pass" } }], edges: [...graph.edges, defaultEdge("g", "planner", "gate")] })).toEqual([]);
    const escalated = { ...graph, edges: graph.edges.map((edge) => edge.id === "p-a" ? edge : edge.from === "auditor-a" ? { ...edge, context: { ...edge.context, policy: { ...edge.context.policy, trust: "system" as const } } } : edge) };
    expect(codes(escalated)).toEqual(["CONTEXT_TRUST_ESCALATION"]);
  });

  it("requires model roles and checkpoint policy from the run configuration", () => {
    const graph = reviewed();
    const withAuditor = { ...graph, nodes: [...graph.nodes, { id: "auditor-d", kind: "model" as const, label: "Auditor D", goal: goal("x") }], edges: [...graph.edges, defaultEdge("p-d", "preflight", "auditor-d"), defaultEdge("d-c", "auditor-d", "consensus")] };
    expect(codes(withAuditor)).toEqual([]);
    expect(codes(withAuditor, { configuration: config({ checkpoints: { mode: "interactive" } }) })).toEqual(["MODEL_ROLE_UNAVAILABLE"]);
    expect(codes(graph, { configuration: config({}) })).toEqual(["CHECKPOINT_POLICY_REQUIRED"]);
    expect(codes(graph, { configuration: config({ checkpoints: { mode: "automatic" } }) })).toEqual(["AUTOMATIC_CHECKPOINT_DECISION_REQUIRED"]);
    expect(codes(graph, { configuration: config({ checkpoints: { mode: "automatic", decisions: { signoff: "approve", ghost: "approve" } } }) })).toEqual(["UNKNOWN_CHECKPOINT_NODE"]);
    const validation = validateAuthoredGraph(graph, options({ configuration: config({ checkpoints: { mode: "interactive" } }) }));
    expect(validation).toMatchObject({ valid: true, configurationChecked: true, version: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it("rejects control-plane, write-authority and Testing-execution changes unless each is authorized", () => {
    const graph = reviewed();
    const privileged: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "signoff" ? { ...node, config: { prompt: "x", writeAuthority: "repository", nested: { protocolSource: "custom" } } } : node),
      edges: graph.edges.map((edge) => edge.id === "p-a" ? { ...edge, prompt: { protocolLayers: ["audit-discovery"] } } : edge),
    };
    const rejected = validateAuthoredGraph(privileged, options());
    expect(rejected.valid).toBe(false);
    expect(rejected.privileged.map(({ category }) => category).sort()).toEqual(["control_plane", "control_plane", "write_authority"]);
    expect(rejected.diagnostics.every(({ code }) => code === "UNAUTHORIZED_CHANGE")).toBe(true);
    expect(codes(privileged, { authorize: ["control_plane"] })).toEqual(["UNAUTHORIZED_CHANGE"]);
    expect(codes(privileged, { authorize: ["control_plane", "write_authority"] })).toEqual([]);
    const execute = { ...graph, nodes: graph.nodes.map((node) => node.id === "signoff" ? { ...node, id: "execute" } : node), edges: graph.edges.map((edge) => ({ ...edge, from: edge.from === "signoff" ? "execute" : edge.from, to: edge.to === "signoff" ? "execute" : edge.to })) };
    expect(validateAuthoredGraph(execute, options()).privileged.map(({ category }) => category)).toEqual(["testing_execution"]);
  });
});

describe("saved graph dispatch", () => {
  let repository: string;
  let state: string;
  let sequence = 0;
  let clock = 0;
  const orchestrator = (): Orchestrator => new Orchestrator({ repository, stateDirectory: state, newRunId: () => `authored-${++sequence}`, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString() });
  beforeAll(async () => {
    repository = mkdtempSync(join(tmpdir(), "arbitra-authored-repo-"));
    state = mkdtempSync(join(tmpdir(), "arbitra-authored-state-"));
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, "src/handlers.ts"), "export const parse = (value: unknown): string => value as " + "any;\n", "utf8");
  });
  afterAll(() => { for (const directory of [repository, state]) rmSync(directory, { recursive: true, force: true }); });

  it("executes and resumes exactly the saved version, never a later one", async () => {
    const first = orchestrator();
    await expect(first.saveWorkflowGraph({ graph: templateOf(AUDIT_DEEP_GRAPH) })).rejects.toMatchObject({ statusCode: 422, message: "WORKFLOW_GRAPH_INVALID:UNAUTHORIZED_CHANGE" });
    await expect(first.saveWorkflowGraph({ graph: reviewed(), authorize: ["everything"] })).rejects.toMatchObject({ statusCode: 400 });
    const saved = await first.saveWorkflowGraph({ graph: reviewed() });
    expect(saved).toMatchObject({ created: true, record: { graphId: "reviewed-audit", parentVersion: null, authorizations: [], savedAt: "2026-01-01T00:00:00.000Z" } });
    const { version } = saved.record;
    expect((await first.listWorkflowGraphs()).graphs).toEqual([{ graphId: "reviewed-audit", versions: [expect.objectContaining({ version })] }]);

    const runConfig = config({ graph: { id: "reviewed-audit", version }, checkpoints: { mode: "interactive" } });
    await expect(first.start(config({ graph: { id: "reviewed-audit", version: "0".repeat(64) }, checkpoints: { mode: "interactive" } }))).rejects.toThrow("WORKFLOW_GRAPH_VERSION_ABSENT");
    await expect(first.start(config({ graph: { id: "reviewed-audit", version } }))).rejects.toThrow("WORKFLOW_GRAPH_INVALID:reviewed-audit:CHECKPOINT_POLICY_REQUIRED");
    expect(await first.runIds()).toEqual([]);
    expect(() => config({ graph: { id: "reviewed-audit", version }, preset: "audit-deep" })).toThrow("exclusive");
    expect(() => runConfigSchema.parse({ ...baseConfig, mode: "feature", workflow: { graph: { id: "reviewed-audit", version } } })).toThrow("audit mode");

    const run = await first.run(runConfig);
    expect(run.state).toBe("BLOCKED");
    const blocked = await orchestrator().status(run.runId);
    expect(blocked.workflowGraph).toEqual({ id: "reviewed-audit", version, executedVersion: version });
    expect(blocked.workflow).toEqual(reviewed());
    const context = JSON.parse(await readFile(join(state, "runs", run.runId, "context.json"), "utf8")) as { workflowGraph: unknown; maximumRounds: number };
    // The loop's explicit maximum (1) caps the configured two rounds.
    expect(context).toMatchObject({ workflowGraph: { id: "reviewed-audit", version }, maximumRounds: 1 });

    // A later version of the same graph does not change the blocked run.
    const next = await orchestrator().saveWorkflowGraph({ graph: { ...reviewed(), nodes: reviewed().nodes.map((node) => node.id === "signoff" ? { ...node, label: "Second sign-off" } : node) }, parentVersion: version });
    expect(next.record.parentVersion).toBe(version);
    expect(next.record.version).not.toBe(version);
    const checkpoint = blocked.checkpoints.find((item) => item.kind === "human");
    if (checkpoint?.kind !== "human") throw new Error("CHECKPOINT_ABSENT");
    await orchestrator().respondCheckpoint(run.runId, "signoff", { version: checkpoint.version, decision: "approve" });
    const resumed = orchestrator();
    await resumed.resume(run.runId);
    const completed = await resumed.wait(run.runId);
    expect(completed).toMatchObject({ state: "COMPLETED", workflowGraph: { id: "reviewed-audit", version, executedVersion: version } });
    expect((await resumed.gate(run.runId)).reasons).not.toContain("checkpoint_pending:signoff");

    // Replay executes the same version and cannot edit it.
    await expect(orchestrator().replay(run.runId, { consensusPolicy: "full", maximumRounds: 1, criticEnabled: false })).rejects.toThrow("REPLAY_SAVED_GRAPH_IMMUTABLE");
    const replay = await orchestrator().replay(run.runId, { consensusPolicy: "full", maximumRounds: 1, criticEnabled: true });
    expect((await orchestrator().status(replay.runId)).workflowGraph).toEqual({ id: "reviewed-audit", version, executedVersion: version });
  });

  it("runs an explicitly authorized graph that reuses a shipped preset ID as an Audit graph", async () => {
    const subject = orchestrator();
    await expect(subject.saveWorkflowGraph({ graph: reviewed("feature-simple") })).rejects.toThrow("WORKFLOW_GRAPH_INVALID:UNAUTHORIZED_CHANGE");
    const { record } = await subject.saveWorkflowGraph({ graph: reviewed("feature-simple"), authorize: ["shipped_preset_id", "write_authority"] });
    expect(record.authorizations).toEqual(["shipped_preset_id"]);
    const run = await subject.run(config({ graph: { id: "feature-simple", version: record.version }, checkpoints: { mode: "interactive" } }));
    expect(run.state).toBe("BLOCKED");
    // The shipped Feature preset is not replaced: status reads the Audit run's own checkpoint.
    expect((await orchestrator().status(run.runId)).checkpoints).toEqual([expect.objectContaining({ kind: "human", checkpointId: "signoff" })]);
  });

  it("refuses to resume a run whose saved version is missing or differs from what ran", async () => {
    const subject = orchestrator();
    const graph = { ...reviewed("tamper-audit") };
    const { record } = await subject.saveWorkflowGraph({ graph });
    const run = await subject.run(config({ graph: { id: "tamper-audit", version: record.version }, checkpoints: { mode: "interactive" } }));
    expect(run.state).toBe("BLOCKED");
    const definitionPath = join(state, "runs", run.runId, "definition.json");
    const definition = JSON.parse(await readFile(definitionPath, "utf8")) as { graph: WorkflowGraph };
    await writeFile(definitionPath, JSON.stringify({ ...definition, graph: { ...definition.graph, nodes: definition.graph.nodes.filter(({ id }) => id !== "critic"), edges: definition.graph.edges.filter(({ to }) => to !== "critic") } }));
    await expect(orchestrator().resume(run.runId)).rejects.toThrow(`RUN_WORKFLOW_GRAPH_MISMATCH:tamper-audit:${record.version}`);
    await writeFile(definitionPath, JSON.stringify(definition));
    await rm(join(state, "workflows", "versions", "tamper-audit"), { recursive: true });
    await expect(orchestrator().resume(run.runId)).rejects.toThrow("WORKFLOW_GRAPH_VERSION_ABSENT");
  });
});
