import type { CoreCommandResult, OrchestratorCore, WorkflowCommand } from "../core.js";

const USAGE = "USAGE: workflow list | workflow show <graph-id> [version] | workflow validate <graph.json> [--configuration=<id>] [--authorize=<category,...>] | workflow save <graph.json> [--parent=<version>] [--configuration=<id>] [--authorize=<category,...>]";

/**
 * `workflow` manages operator-authored graphs through the orchestrator's validator and
 * version store, the same operations the HTTP routes expose. Privileged changes need an
 * explicit `--authorize=` naming each category; there is no blanket flag.
 */
export async function executeWorkflow(core: OrchestratorCore, argv: readonly string[]): Promise<CoreCommandResult> {
  if (core.workflow === undefined) throw new Error(USAGE);
  return core.workflow(parseWorkflowCommand(argv));
}

export function parseWorkflowCommand(argv: readonly string[]): WorkflowCommand {
  const [action, ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const argument of rest) {
    const flag = /^--(configuration|authorize|parent)=(.+)$/u.exec(argument);
    if (flag !== null) { if (flags.has(flag[1] as string)) throw new Error(USAGE); flags.set(flag[1] as string, flag[2] as string); }
    else if (argument.startsWith("--")) throw new Error(USAGE);
    else positional.push(argument);
  }
  if (action === "list" && positional.length === 0 && flags.size === 0) return { action };
  if (action === "show" && flags.size === 0 && (positional.length === 1 || positional.length === 2)) {
    const [graphId, version] = positional as [string, string?];
    return version === undefined ? { action, graphId } : { action, graphId, version };
  }
  if ((action === "validate" || action === "save") && positional.length === 1 && (action === "save" || !flags.has("parent"))) {
    const configurationId = flags.get("configuration"); const parentVersion = flags.get("parent");
    return { action, graphPath: positional[0] as string, authorize: flags.get("authorize")?.split(",") ?? [],
      ...(configurationId === undefined ? {} : { configurationId }), ...(parentVersion === undefined ? {} : { parentVersion }) };
  }
  throw new Error(USAGE);
}
