export type ExecutionPolicy = "derived_repository_script" | "allowlisted" | "requires_approval";

export interface CommandRule {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface PlannedCommand {
  readonly command: string;
  readonly executionPolicy: ExecutionPolicy;
  readonly executable: boolean;
}

export class CommandRequiresApprovalError extends Error {
  constructor(readonly command: string) {
    super(`COMMAND_REQUIRES_APPROVAL:${command}`);
    this.name = "CommandRequiresApprovalError";
  }
}

export function classifyCommand(
  command: string,
  repositoryScripts: readonly (CommandRule | string)[],
  allowlist: readonly (CommandRule | string)[],
): ExecutionPolicy {
  const parsed = parseCommand(command);
  if (parsed === null) return "requires_approval";
  if (repositoryScripts.some((rule) => sameCommand(parsed, rule))) return "derived_repository_script";
  if (allowlist.some((rule) => sameCommand(parsed, rule))) return "allowlisted";
  return "requires_approval";
}

export function classifyPlannedCommand(
  command: string,
  repositoryScripts: readonly (CommandRule | string)[],
  allowlist: readonly (CommandRule | string)[],
): PlannedCommand {
  const executionPolicy = classifyCommand(command, repositoryScripts, allowlist);
  return Object.freeze({ command, executionPolicy, executable: executionPolicy !== "requires_approval" });
}

/** Sole execution gate: callers must present a freshly classified command. */
export function assertCommandExecutable(command: PlannedCommand): void {
  if (!command.executable || command.executionPolicy === "requires_approval") {
    throw new CommandRequiresApprovalError(command.command);
  }
}

function sameCommand(parsed: CommandRule, rule: CommandRule | string): boolean {
  const expected = typeof rule === "string" ? parseCommand(rule) : rule;
  return expected !== null
    && parsed.executable === expected.executable
    && parsed.arguments.length === expected.arguments.length
    && parsed.arguments.every((value, index) => value === expected.arguments[index]);
}

function parseCommand(command: string): CommandRule | null {
  const trimmed = command.trim();
  if (trimmed.length === 0 || /[;&|<>`\r\n]|\$\(|\$\{|%[^%]+%/u.test(trimmed)) return null;
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/gu;
  let consumed = 0;
  for (const match of trimmed.matchAll(pattern)) {
    if (match.index !== consumed && trimmed.slice(consumed, match.index).trim().length > 0) return null;
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["\\])/gu, "$1"));
    consumed = (match.index ?? 0) + match[0].length;
  }
  if (trimmed.slice(consumed).trim().length > 0 || tokens.length === 0) return null;
  const [executable, ...arguments_] = tokens;
  if (executable === undefined) return null;
  return Object.freeze({ executable, arguments: Object.freeze(arguments_) });
}
