import { describe, expect, it } from "vitest";
import { exitPolicy } from "../src/exit-policy.js";

describe("exitPolicy", () => {
  it.each([
    ["passed", 0, "passed", []],
    ["failed", 1, "failed", ["policy_gate_failed"]],
    ["system_failure", 2, "system_failure", ["system_failure"]],
    ["suspended", 3, "suspended", ["suspended_or_blocked"]],
    ["unknown", 2, "system_failure", ["trustworthy_result_not_established"]],
  ] as const)("maps %s to exit %i", (disposition, exit, gateStatus, reasons) => {
    expect(exitPolicy({ disposition })).toEqual({ exit, gateStatus, reasons });
  });

  it("preserves policy reasons", () => {
    expect(exitPolicy({ disposition: "failed", reasons: ["unresolved_high", "suppression_risk"] })).toEqual({
      exit: 1,
      gateStatus: "failed",
      reasons: ["unresolved_high", "suppression_risk"],
    });
  });

  it("does not pass a contradictory result with gate-failure reasons", () => {
    expect(exitPolicy({ disposition: "passed", reasons: ["unresolved_high"] })).toEqual({
      exit: 1,
      gateStatus: "failed",
      reasons: ["unresolved_high"],
    });
  });

  it("fails closed for an unrecognised runtime disposition", () => {
    expect(exitPolicy({ disposition: "unexpected" } as never)).toEqual({
      exit: 2,
      gateStatus: "system_failure",
      reasons: ["unrecognised_result_disposition"],
    });
  });
});
