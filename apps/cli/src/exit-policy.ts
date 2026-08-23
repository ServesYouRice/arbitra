export const EXIT_CODES = {
  passed: 0,
  failed: 1,
  systemFailure: 2,
  suspended: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
export type GateStatus = "passed" | "failed" | "system_failure" | "suspended";

export type ResultDisposition =
  | "passed"
  | "failed"
  | "system_failure"
  | "suspended"
  | "unknown";

export interface ExitPolicyInput {
  readonly disposition: ResultDisposition;
  readonly reasons?: readonly string[];
}

export interface ExitPolicyDecision {
  readonly exit: ExitCode;
  readonly gateStatus: GateStatus;
  readonly reasons: readonly string[];
}

const DEFAULT_REASONS: Readonly<Record<ResultDisposition, readonly string[]>> = {
  passed: [],
  failed: ["policy_gate_failed"],
  system_failure: ["system_failure"],
  suspended: ["suspended_or_blocked"],
  unknown: ["trustworthy_result_not_established"],
};

/** The sole mapping from domain outcomes to process exit codes. Unknown fails closed. */
export function exitPolicy(result: ExitPolicyInput): ExitPolicyDecision {
  const fallback = DEFAULT_REASONS[result.disposition] ?? ["unrecognised_result_disposition"];
  const reasons = normaliseReasons(result.reasons, fallback);
  if (result.disposition === "passed" && reasons.length > 0) {
    return { exit: EXIT_CODES.failed, gateStatus: "failed", reasons };
  }
  switch (result.disposition) {
    case "passed":
      return { exit: EXIT_CODES.passed, gateStatus: "passed", reasons };
    case "failed":
      return { exit: EXIT_CODES.failed, gateStatus: "failed", reasons };
    case "suspended":
      return { exit: EXIT_CODES.suspended, gateStatus: "suspended", reasons };
    case "system_failure":
      return { exit: EXIT_CODES.systemFailure, gateStatus: "system_failure", reasons };
    case "unknown":
      return { exit: EXIT_CODES.systemFailure, gateStatus: "system_failure", reasons };
    default:
      return {
        exit: EXIT_CODES.systemFailure,
        gateStatus: "system_failure",
        reasons: ["unrecognised_result_disposition"],
      };
  }
}

function normaliseReasons(
  reasons: readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] {
  const present = reasons?.filter((reason) => reason.length > 0) ?? [];
  return present.length > 0 ? [...present] : [...fallback];
}
