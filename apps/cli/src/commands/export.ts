import type { CoreCommandResult } from "../core.js";

export interface ExportCommandPort { exportRun(runId: string, format: "json"): Promise<CoreCommandResult> }
export async function executeExport(core: ExportCommandPort, argv: readonly string[]): Promise<CoreCommandResult> {
  const [runId, ...options] = argv;
  if (runId === undefined || runId.startsWith("--")) return { disposition: "system_failure", reasons: ["missing_argument:export"], value: null };
  if (options.length !== 0 && (options.length !== 2 || options[0] !== "--format")) return { disposition: "system_failure", reasons: ["invalid_arguments:export"], value: null };
  const format = options[1] ?? "json";
  if (format !== "json") return { disposition: "system_failure", reasons: ["invalid_export_format"], value: null };
  return core.exportRun(runId, format);
}
