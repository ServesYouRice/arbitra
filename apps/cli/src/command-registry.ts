export const IMPLEMENTED_COMMANDS = ["validate", "estimate", "run", "audit", "status", "resume", "replay", "diff", "trace", "export", "report", "requirements", "approve-requirements", "revise-requirements", "apply-requirements-revision", "respond-checkpoint", "batches", "resolve-batch", "workflow", "incremental", "apply-changes"] as const;

export type ImplementedCommand = (typeof IMPLEMENTED_COMMANDS)[number];

export function isImplementedCommand(value: string): value is ImplementedCommand {
  return IMPLEMENTED_COMMANDS.some((command) => command === value);
}
