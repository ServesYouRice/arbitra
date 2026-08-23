import { describe, expect, it } from "vitest";
import { IMPLEMENTED_COMMANDS, RESERVED_COMMANDS } from "../src/command-registry.js";
import type { CoreCommandResult, OrchestratorCore } from "../src/core.js";
import { runCli } from "../src/main.js";
import { isCliJsonOutput } from "../src/output/json.js";

class FakeWorkflowCore implements OrchestratorCore {
  readonly calls: string[] = [];
  providerCalls = 0;

  async validate(configPath: string): Promise<CoreCommandResult> {
    this.calls.push(`validate:${configPath}`);
    return { disposition: "passed", value: { valid: true, configPath } };
  }

  async run(configPath: string): Promise<CoreCommandResult> {
    this.calls.push(`run:${configPath}`);
    return { disposition: "passed", value: { runId: "fake-run", state: "COMPLETED" } };
  }

  async audit(request: Parameters<OrchestratorCore["audit"]>[0]): Promise<CoreCommandResult> {
    this.calls.push(`audit:${JSON.stringify(request)}`);
    return { disposition: "passed", value: { graph: { id: "canonical-audit", version: 1 }, request, canonicalIssues: [] } };
  }

  async estimate(configPath: string): Promise<CoreCommandResult> {
    this.calls.push(`estimate:${configPath}`);
    return { disposition: "passed", value: {
      fanOut: [{ stage: "discovery", providerId: "fixture", calls: 3 }],
      tokens: { minimum: 3_000, maximum: 6_000 },
      cost: { minimum: 0.03, maximum: 0.06, currency: "USD" },
      uncertainty: ["token_range:discovery"],
      budgetVerdict: "within_budget",
    } };
  }

  async status(runId: string): Promise<CoreCommandResult> {
    this.calls.push(`status:${runId}`);
    return { disposition: "passed", value: { runId, state: "COMPLETED" } };
  }

  async resume(runId: string): Promise<CoreCommandResult> {
    this.calls.push(`resume:${runId}`);
    return { disposition: "passed", value: { runId, state: "COMPLETED", resumed: true } };
  }

  async replay(runId: string, overrides: Parameters<OrchestratorCore["replay"]>[1]): Promise<CoreCommandResult> {
    this.calls.push(`replay:${runId}:${JSON.stringify(overrides)}`);
    return { disposition: "passed", value: { runId: `${runId}-replay`, sourceRunId: runId, overrides } };
  }

  async diff(runA: string, runB: string): Promise<CoreCommandResult> {
    this.calls.push(`diff:${runA}:${runB}`);
    return { disposition: "passed", value: { runA, runB, addedIssueIds: [], removedIssueIds: [] } };
  }

  async trace(runId: string): Promise<CoreCommandResult> {
    this.calls.push(`trace:${runId}`);
    return { disposition: "passed", value: { runId, activities: [] } };
  }

  async exportRun(runId: string, format: "json"): Promise<CoreCommandResult> {
    this.calls.push(`export:${runId}:${format}`);
    return { disposition: "passed", value: { runId, format, redactionCount: 1, issues: [] } };
  }

  async report(runId: string): Promise<CoreCommandResult> {
    this.calls.push(`report:${runId}`);
    return { disposition: "passed", value: { runId, rows: [], denominator: { activityCount: 0, auditorCount: 0, groundTruthAvailable: false } } };
  }
}

function captureIo(): { io: { writeStdout(text: string): void; writeStderr(text: string): void }; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { writeStdout: (text) => stdout.push(text), writeStderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

describe("CLI commands", () => {
  it("exposes the complete public command registry with estimate implemented", () => {
    expect([...IMPLEMENTED_COMMANDS].sort()).toEqual(
      ["validate", "estimate", "run", "audit", "resume", "status", "replay", "diff", "trace", "export", "report"].sort(),
    );
    expect(RESERVED_COMMANDS).toEqual([]);
    expect(IMPLEMENTED_COMMANDS).toContain("estimate");
    expect(IMPLEMENTED_COMMANDS).toContain("audit");
  });

  it.each([
    ["validate", "workflow.json"],
    ["estimate", "workflow.json"],
    ["run", "workflow.json"],
    ["status", "fake-run"],
    ["resume", "fake-run"],
  ] as const)("executes %s through the core and emits stable JSON", async (command, subject) => {
    const core = new FakeWorkflowCore();
    const capture = captureIo();
    const execution = await runCli([command, subject, "--json"], core, capture.io);
    expect(execution.exit).toBe(0);
    expect(core.calls).toEqual([`${command}:${subject}`]);
    expect(capture.stderr).toEqual([]);
    const payload: unknown = JSON.parse(capture.stdout.join(""));
    expect(isCliJsonOutput(payload)).toBe(true);
    expect(payload).toEqual(execution.output);
    if (command === "estimate") expect(core.providerCalls).toBe(0);
  });

  it("fails closed when the core cannot establish a trustworthy result", async () => {
    const core = new FakeWorkflowCore();
    core.run = async () => ({ disposition: "unknown", value: { state: "PARTIAL" } });
    const capture = captureIo();
    const execution = await runCli(["run", "workflow.json", "--json"], core, capture.io);
    expect(execution.exit).toBe(2);
    expect(execution.output.policy.reasons).toEqual(["trustworthy_result_not_established"]);
    expect(isCliJsonOutput(JSON.parse(capture.stdout.join("")) as unknown)).toBe(true);
    expect(capture.stderr).toEqual([]);
  });

  it("renders estimate economics in human form without dispatching a provider", async () => {
    const core = new FakeWorkflowCore();
    const capture = captureIo();
    const execution = await runCli(["estimate", "workflow.json"], core, capture.io);
    expect(execution.exit).toBe(0);
    expect(core.providerCalls).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join("")).toContain([
      "estimate: passed",
      "budget: within_budget",
      "fan-out:",
      "  - discovery / fixture: 3 calls",
      "tokens: 3,000-6,000",
      "cost: USD 0.030000-USD 0.060000",
      "uncertainty: token_range:discovery",
    ].join("\n"));
  });

  it("renders security consensus sections in human and machine output", async () => {
    const core = new FakeWorkflowCore();
    core.run = async () => ({ disposition: "passed", value: {
      suppressionCandidates: [{
        path: "src/auth.ts",
        readBy: ["auditor-a"],
        findingsCiting: [],
        note: "This is not proof of a defect or an attack; it is an unresolved audit uncertainty.",
      }],
      securityCoverage: { degraded: true, reason: "overlap_budget_exceeded" },
      unexaminedSurfaces: [{ surfaceId: "billing", paths: ["src/billing.ts"], weight: "critical" }],
    } });

    const human = captureIo();
    const execution = await runCli(["run", "workflow.json"], core, human.io);
    expect(execution.exit).toBe(0);
    expect(human.stdout.join("")).toContain([
      "security coverage: degraded (overlap_budget_exceeded)",
      "suppression candidates: 1",
      "  - src/auth.ts; read by: auditor-a; findings citing: none",
      "    This is not proof of a defect or an attack; it is an unresolved audit uncertainty.",
      "unexamined surfaces: 1",
      "  - [critical] billing: src/billing.ts",
    ].join("\n"));

    const machine = captureIo();
    await runCli(["run", "workflow.json", "--json"], core, machine.io);
    const payload = JSON.parse(machine.stdout.join("")) as { result: Record<string, unknown> };
    expect(Object.keys(payload.result).sort()).toEqual([
      "securityCoverage", "suppressionCandidates", "unexaminedSurfaces",
    ]);
  });

  it.each([
    [["--full"], { kind: "full" }],
    [["--module", "auth"], { kind: "module", moduleId: "auth" }],
    [["--preset", "diff-fast", "--staged"], { kind: "diff", target: "staged" }],
    [["--preset", "diff-fast", "--working-tree"], { kind: "diff", target: "working_tree" }],
    [["--preset", "diff-review", "--base", "origin/trunk", "--head", "HEAD"], { kind: "diff", target: "range", base: "origin/trunk", head: "HEAD" }],
    [["--preset", "diff-deep", "--range", "release...topic"], { kind: "diff", target: "range", range: "release...topic" }],
  ] as const)("executes an Audit target through the canonical graph: %j", async (args, target) => {
    const core = new FakeWorkflowCore(); const capture = captureIo();
    const execution = await runCli(["audit", ...args, "--json"], core, capture.io);
    expect(execution.exit).toBe(0);
    expect(execution.output.result).toMatchObject({ graph: { id: "canonical-audit", version: 1 }, request: { target } });
    expect(isCliJsonOutput(JSON.parse(capture.stdout.join("")) as unknown)).toBe(true);
  });

  it("returns exit 1 and valid JSON for a diff-review unresolved high issue", async () => {
    const core = new FakeWorkflowCore();
    core.audit = async (request) => ({ disposition: "failed", reasons: ["unresolved_high_issue"], value: { graph: { id: "canonical-audit", version: 1 }, request, canonicalIssues: [{ candidateId: "C-1", severity: "high", disposition: "needs_verification" }], suppressionCandidates: [], securityCoverage: { degraded: false, reason: null }, unexaminedSurfaces: [] } });
    const capture = captureIo(); const execution = await runCli(["audit", "--preset", "diff-review", "--base", "origin/trunk", "--head", "HEAD", "--json"], core, capture.io);
    expect(execution.exit).toBe(1);
    expect(execution.output.policy).toMatchObject({ gateStatus: "failed", reasons: ["unresolved_high_issue"] });
    expect(isCliJsonOutput(JSON.parse(capture.stdout.join("")) as unknown)).toBe(true);
  });

  it("preserves prominent fork warnings and suppression candidates in human and JSON output", async () => {
    const core = new FakeWorkflowCore();
    const value = { warnings: [{ prominence: "prominent", code: "UNTRUSTED_FORK_OR_CROSS_REMOTE_DIFF" }], suppressionCandidates: [{ path: "src/auth.ts", readBy: ["auditor-a"], findingsCiting: [], note: "This is not proof of a defect or an attack; it is an unresolved audit uncertainty." }], securityCoverage: { degraded: false, reason: null }, unexaminedSurfaces: [] };
    core.audit = async () => ({ disposition: "passed", value });
    const machine = captureIo(); const execution = await runCli(["audit", "--preset", "diff-review", "--range", "origin/trunk...fork/topic", "--json"], core, machine.io);
    expect(execution.output.result).toEqual(value);
    expect(JSON.parse(machine.stdout.join(""))).toMatchObject({ result: { warnings: [{ prominence: "prominent" }], suppressionCandidates: [{ path: "src/auth.ts" }] } });
    const human = captureIo(); await runCli(["audit", "--preset", "diff-review", "--range", "origin/trunk...fork/topic"], core, human.io);
    expect(human.stdout.join("")).toContain("suppression candidates: 1");
  });

  it.each([
    ["replay", ["run-a", "--consensus-policy", "full", "--max-rounds", "2", "--no-critic"], "replay:run-a:{\"consensusPolicy\":\"full\",\"maximumRounds\":2,\"criticEnabled\":false}"],
    ["diff", ["run-a", "run-b"], "diff:run-a:run-b"],
    ["trace", ["run-a"], "trace:run-a"],
    ["export", ["run-a", "--format", "json"], "export:run-a:json"],
  ] as const)("executes %s through the core with the stable JSON envelope", async (command, args, expectedCall) => {
    const core = new FakeWorkflowCore();
    const capture = captureIo();
    const execution = await runCli([command, ...args, "--json"], core, capture.io);
    expect(execution.exit).toBe(0);
    expect(core.calls).toEqual([expectedCall]);
    expect(isCliJsonOutput(JSON.parse(capture.stdout.join("")) as unknown)).toBe(true);
    expect(capture.stderr).toEqual([]);
  });

  it.each([
    [["replay"], "missing_argument:replay"],
    [["replay", "run-a", "--consensus-policy", "unknown"], "invalid_consensus_policy"],
    [["replay", "run-a", "--max-rounds", "4"], "invalid_max_rounds"],
    [["replay", "run-a", "--max-rounds"], "missing_value:--max-rounds"],
    [["replay", "run-a", "--unknown", "value"], "invalid_arguments:replay"],
    [["diff", "run-a"], "invalid_arguments:diff"],
    [["trace", "run-a", "extra"], "invalid_arguments:trace"],
    [["export", "run-a", "--format", "html"], "invalid_export_format"],
    [["export", "run-a", "extra"], "invalid_arguments:export"],
  ] as const)("fails closed for invalid command arguments: %j", async (args, reason) => {
    const capture = captureIo();
    const execution = await runCli([...args, "--json"], new FakeWorkflowCore(), capture.io);
    expect(execution.exit).toBe(2);
    expect(execution.output.policy.reasons).toEqual([reason]);
  });

  it("converts core exceptions to a system failure", async () => {
    const core = new FakeWorkflowCore();
    core.status = async () => { throw new Error("journal unavailable"); };
    const capture = captureIo();
    const execution = await runCli(["status", "fake-run"], core, capture.io);
    expect(execution.exit).toBe(2);
    expect(execution.output.result).toEqual({ message: "journal unavailable" });
  });
});
