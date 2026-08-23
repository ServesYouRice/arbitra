export const IMPLEMENTED_COMMANDS = ["validate", "estimate", "run", "audit", "status", "resume", "replay", "diff", "trace", "export", "report"] as const;
export const RESERVED_COMMANDS = [] as const;

export type ImplementedCommand = (typeof IMPLEMENTED_COMMANDS)[number];
export type ReservedCommand = (typeof RESERVED_COMMANDS)[number];
export type CommandName = ImplementedCommand | ReservedCommand;

export function isImplementedCommand(value: string): value is ImplementedCommand {
  return IMPLEMENTED_COMMANDS.some((command) => command === value);
}

export function isReservedCommand(value: string): value is ReservedCommand {
  return (RESERVED_COMMANDS as readonly string[]).includes(value);
}
