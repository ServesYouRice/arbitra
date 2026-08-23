import type { CoreCommandResult } from "../core.js";

export interface ReplayCommandPort { replay(runId: string, overrides: { readonly consensusPolicy: "full" | "risk_weighted" | "minimal"; readonly maximumRounds: 1 | 2 | 3; readonly criticEnabled: boolean }): Promise<CoreCommandResult> }

export async function executeReplay(core: ReplayCommandPort, argv: readonly string[]): Promise<CoreCommandResult> {
  const [runId, ...options] = argv;
  if (runId === undefined || runId.startsWith("--")) return invalid("missing_argument:replay");
  let consensusPolicy: "full" | "risk_weighted" | "minimal" = "risk_weighted";
  let maximumRounds: 1 | 2 | 3 = 3;
  let criticEnabled = true;
  const seen = new Set<string>();
  for (let index = 0; index < options.length; index += 1) {
    const name = options[index]!;
    if (seen.has(name)) return invalid("duplicate_option:replay");
    seen.add(name);
    if (name === "--no-critic") { criticEnabled = false; continue; }
    const value = options[index + 1];
    if (value === undefined || value.startsWith("--")) return invalid(`missing_value:${name}`);
    index += 1;
    if (name === "--consensus-policy") {
      if (value !== "full" && value !== "risk_weighted" && value !== "minimal") return invalid("invalid_consensus_policy");
      consensusPolicy = value;
    } else if (name === "--max-rounds") {
      const parsed = Number(value);
      if (parsed !== 1 && parsed !== 2 && parsed !== 3) return invalid("invalid_max_rounds");
      maximumRounds = parsed;
    } else return invalid("invalid_arguments:replay");
  }
  return core.replay(runId, { consensusPolicy, maximumRounds, criticEnabled });
}

function invalid(reason: string): CoreCommandResult { return { disposition: "system_failure", reasons: [reason], value: null }; }
