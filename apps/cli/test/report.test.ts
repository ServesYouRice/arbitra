import { describe, expect, it } from "vitest";
import { IMPLEMENTED_COMMANDS } from "../src/command-registry.js";
import { executeReport, redactReport } from "../src/commands/report.js";
import type { CoreCommandResult, OrchestratorCore } from "../src/core.js";
import { runCli } from "../src/main.js";

describe("report command redaction and refusal passthrough", () => {
  it("is a registered command reachable through the dispatcher", async () => {
    expect(IMPLEMENTED_COMMANDS).toContain("report");
    const io = capture();
    const execution = await runCli(["report", "run-1", "--json"], core(), io);
    expect(execution.exit).toBe(0);
    expect(execution.output.command).toBe("report");
  });

  it("redacts every secret-shaped string in a report before it leaves the application", async () => {
    const result = await executeReport({ async report() { return { disposition: "passed", value: { rows: [{ modelIdentity: "model-a", note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }], key: "AKIAIOSFODNN7EXAMPLE", nested: { list: ["ghp_abcdefghijklmnopqrstuvwxyz012345"] } } }; } }, ["run-1"]);
    const encoded = JSON.stringify(result.value);
    expect(encoded).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(encoded).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(encoded).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(encoded).toContain("model-a");
    expect(result.value).toMatchObject({ redaction: { patternVersion: "1", count: 3 } });
  });

  it("fails closed rather than printing a report redaction could not clean", async () => {
    const io = capture();
    const unredactable: OrchestratorCore = { ...core(), async report() { return { disposition: "passed", value: { token: { toJSON: () => "AKIAIOSFODNN7EXAMPLE" } } }; } };
    const execution = await runCli(["report", "run-1", "--json"], unredactable, io);
    expect(execution.output.policy.reasons).toContain("report_redaction_failed");
    expect(execution.output.result).toBeNull();
    expect(io.stdout.join("")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(io.stderr.join("")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("passes a query-layer aggregation refusal through without inventing a comparison", async () => {
    const refusing: OrchestratorCore = { ...core(), async report() { return { disposition: "system_failure", reasons: ["CROSS_PROTOCOL_COMPARISON_REFUSED"], value: { message: "audit@1.0.0 and audit@2.0.0 are different protocol identities" } }; } };
    const execution = await runCli(["report", "run-1", "--json"], refusing, capture());
    expect(execution.output.policy.reasons).toContain("CROSS_PROTOCOL_COMPARISON_REFUSED");
    expect(execution.output.result).toMatchObject({ report: { message: "audit@1.0.0 and audit@2.0.0 are different protocol identities" } });
  });

  it("preserves unmeasured values as null rather than coercing them to zero", () => {
    expect(redactReport({ recall: null, precision: null, costUsd: 0 })).toMatchObject({ report: { recall: null, precision: null, costUsd: 0 }, redaction: { count: 0 } });
  });

  it("rejects a missing run identifier and unexpected options", async () => {
    expect(await executeReport(core(), [])).toMatchObject({ disposition: "system_failure", reasons: ["missing_argument:report"] });
    expect(await executeReport(core(), ["--json"])).toMatchObject({ disposition: "system_failure", reasons: ["missing_argument:report"] });
    expect(await executeReport(core(), ["run-1", "--extra"])).toMatchObject({ disposition: "system_failure", reasons: ["invalid_arguments:report"] });
  });
});

function core(): OrchestratorCore {
  const clear = async (): Promise<CoreCommandResult> => ({ disposition: "passed", value: {} });
  return { validate: clear, estimate: clear, run: clear, audit: clear, status: clear, resume: clear, replay: clear, diff: clear, trace: clear, exportRun: clear, async report() { return { disposition: "passed", value: { rows: [], denominator: { activityCount: 0, auditorCount: 0, groundTruthAvailable: false } } }; } };
}
function capture() { const stdout: string[] = []; const stderr: string[] = []; return { stdout, stderr, writeStdout: (text: string) => { stdout.push(text); }, writeStderr: (text: string) => { stderr.push(text); } }; }
