import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunConfig } from "@arbitra/schemas/config.js";
import type { ReplayOverrides } from "@arbitra/core/replay/index.js";
import type { Orchestrator } from "./orchestrator.js";

export interface CoreCommandResult {
  readonly disposition: "passed" | "failed" | "system_failure" | "suspended" | "unknown";
  readonly reasons?: readonly string[];
  readonly value?: unknown;
}

export type AuditCliTarget = Readonly<
  { kind: "full" }
  | { kind: "module"; moduleId: string }
  | { kind: "diff"; target: "staged" | "working_tree" | "range"; base?: string; head?: string; range?: string }
>;

/**
 * The CLI's port, satisfied by the one orchestrator.
 *
 * Every command maps a domain outcome onto a disposition and lets `exitPolicy` turn that
 * into the process exit code. Nothing here re-derives a gate: the gate is the
 * orchestrator's, so CI and the UI cannot disagree about whether a run passed.
 */
export function orchestratorCore(orchestrator: Orchestrator) {
  const load = async (configPath: string): Promise<RunConfig> => {
    const parsed = JSON.parse(await readFile(resolve(configPath), "utf8")) as unknown;
    return orchestrator.configurations.validate(parsed);
  };

  const completed = async (runId: string, state: string): Promise<CoreCommandResult> => {
    if (state === "FAILED") {
      // An operator rejection or a failed gate policy stops the graph, but it is a policy
      // outcome rather than a system failure; report it exactly as the public gate does.
      const gate = await orchestrator.gate(runId);
      if (gate.reasons.some((reason) => reason.startsWith("checkpoint_rejected:") || reason.startsWith("gate_failed:"))) {
        return { disposition: "failed", reasons: gate.reasons, value: { ...await orchestrator.status(runId), gateStatus: gate.gateStatus } };
      }
    }
    if (state !== "COMPLETED") return { disposition: ["BLOCKED", "CANCELLED", "SUSPENDED_BUDGET", "SUSPENDED_RATE_LIMIT"].includes(state) ? "suspended" : "system_failure", reasons: [`run_${state.toLowerCase()}`], value: await orchestrator.status(runId) };
    const gate = await orchestrator.gate(runId);
    return {
      disposition: gate.gateStatus === "passed" ? "passed" : "failed",
      reasons: gate.reasons,
      value: { runId, state, gateStatus: gate.gateStatus, summary: await orchestrator.summary(runId) },
    };
  };

  return {
    async applyRequirementsRevision(runId: string, artifactId: string): Promise<CoreCommandResult> {
      return { disposition: "passed", value: await orchestrator.applyRequirementsRevision(runId, artifactId) };
    },
    /** Record one decision for the current version of a generic human checkpoint. */
    async respondCheckpoint(runId: string, checkpointId: string, version: string, decision: string): Promise<CoreCommandResult> {
      return { disposition: "passed", value: await orchestrator.respondCheckpoint(runId, checkpointId, { version, decision }) };
    },
    async requirements(runId: string): Promise<CoreCommandResult> {
      return { disposition: "passed", value: await orchestrator.requirements(runId) };
    },
    async approveRequirements(runId: string, artifactId: string, ambiguityIds: readonly string[]): Promise<CoreCommandResult> {
      return { disposition: "passed", value: await orchestrator.approveRequirements(runId, { artifactId, ambiguityIds }) };
    },
    async reviseRequirements(runId: string, artifactId: string, draftPath: string): Promise<CoreCommandResult> {
      const draft: unknown = JSON.parse(await readFile(resolve(draftPath), "utf8"));
      return { disposition: "passed", value: await orchestrator.reviseRequirements(runId, artifactId, draft) };
    },
    async validate(configPath: string): Promise<CoreCommandResult> {
      try {
        const config = await load(configPath);
        return { disposition: "passed", reasons: [], value: { valid: true, mode: config.mode } };
      } catch (error) {
        return { disposition: "failed", reasons: ["invalid_configuration"], value: { valid: false, message: describe(error) } };
      }
    },

    async estimate(configPath: string): Promise<CoreCommandResult> {
      return { disposition: "passed", reasons: [], value: await orchestrator.estimate(await load(configPath)) };
    },

    async run(configPath: string): Promise<CoreCommandResult> {
      const { runId, state } = await orchestrator.run(await load(configPath));
      return completed(runId, state);
    },

    /** `audit --preset ... --full` runs the preset without a saved configuration file. */
    async audit(request: { readonly preset: string; readonly target: AuditCliTarget }): Promise<CoreCommandResult> {
      const config = orchestrator.configurations.validate({
        schemaVersion: 1,
        mode: "audit",
        scope: request.target.kind === "diff"
          ? { kind: "diff", diffMode: request.target.target, ...(request.target.range === undefined ? { base: request.target.base ?? "origin/main", head: request.target.head ?? "HEAD" } : { revisionRange: request.target.range }) }
          : request.target.kind === "module" ? { kind: "module", modules: [request.target.moduleId] } : { kind: "repository" },
        auditDepth: request.preset === "diff-fast" ? "fast" : request.preset === "audit-deep" ? "deep" : "balanced",
        consensusPolicy: request.preset === "diff-fast" ? "minimal" : request.preset === "audit-deep" ? "full" : "risk_weighted",
        maxConsensusRounds: request.preset === "diff-fast" ? 0 : request.preset === "audit-deep" ? 3 : 2,
        verification: {}, models: {}, harness: { mode: "canonical" },
        workflow: { preset: request.preset },
        budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {},
      });
      const { runId, state } = await orchestrator.run(config);
      return completed(runId, state);
    },

    async status(runId: string): Promise<CoreCommandResult> {
      const resource = await orchestrator.status(runId);
      return { disposition: resource.state === "COMPLETED" ? "passed" : "suspended", reasons: [], value: resource };
    },

    async resume(runId: string): Promise<CoreCommandResult> {
      await orchestrator.resume(runId);
      return completed(runId, (await orchestrator.wait(runId)).state);
    },

    async replay(runId: string, overrides: ReplayOverrides): Promise<CoreCommandResult> {
      const replayed = await orchestrator.replay(runId, overrides);
      return completed(replayed.runId, replayed.state);
    },

    async diff(runA: string, runB: string): Promise<CoreCommandResult> {
      return { disposition: "passed", reasons: [], value: await orchestrator.diff(runA, runB) };
    },

    async trace(runId: string): Promise<CoreCommandResult> {
      return { disposition: "passed", reasons: [], value: { runId, artifacts: await orchestrator.artifacts(runId) } };
    },

    async exportRun(runId: string, format: "json"): Promise<CoreCommandResult> {
      const artifacts = await orchestrator.artifacts(runId);
      const contents = await Promise.all(artifacts.map(async ({ artifactId, kind }) => [kind, await orchestrator.artifact(runId, artifactId)] as const));
      return { disposition: "passed", reasons: [], value: { runId, format, artifacts: Object.fromEntries(contents) } };
    },

    async report(runId: string): Promise<CoreCommandResult> {
      const gate = await orchestrator.gate(runId);
      return { disposition: gate.gateStatus === "passed" ? "passed" : "failed", reasons: gate.reasons, value: await orchestrator.summary(runId) };
    },
  };
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
