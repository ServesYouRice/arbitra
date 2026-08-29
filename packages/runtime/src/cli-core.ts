import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunConfig } from "@arbitra/schemas/config.js";
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
    if (state !== "COMPLETED") return { disposition: state === "CANCELLED" ? "suspended" : "system_failure", reasons: [`run_${state.toLowerCase()}`], value: { runId, state } };
    const gate = await orchestrator.gate(runId);
    return {
      disposition: gate.gateStatus === "passed" ? "passed" : "failed",
      reasons: gate.reasons,
      value: { runId, state, gateStatus: gate.gateStatus, summary: await orchestrator.summary(runId) },
    };
  };

  return {
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
          ? { kind: "diff", base: request.target.base ?? "origin/main", head: request.target.head ?? "HEAD" }
          : request.target.kind === "module" ? { kind: "module", module: request.target.moduleId } : { kind: "repository" },
        auditDepth: "balanced",
        consensusPolicy: "risk_weighted",
        maxConsensusRounds: 2,
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
      return { disposition: "suspended", reasons: ["resume_started"], value: await orchestrator.resume(runId) };
    },

    /**
     * Replay is not implemented: re-running a recorded run under changed policy needs the
     * replay engine wired to the journal, which this composition root does not yet do.
     * It reports that rather than silently running a fresh audit and calling it a replay.
     */
    async replay(runId: string): Promise<CoreCommandResult> {
      return { disposition: "system_failure", reasons: ["replay_not_wired"], value: { runId, message: "Replay requires the journal replay engine, which is not yet composed." } };
    },

    async diff(runA: string, runB: string): Promise<CoreCommandResult> {
      const [a, b] = await Promise.all([orchestrator.summary(runA), orchestrator.summary(runB)]);
      return { disposition: "passed", reasons: [], value: { a, b } };
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
