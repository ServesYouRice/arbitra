import { posix } from "node:path";

export function isExecutionStateWriteAllowed(path: string, currentTaskId: string): boolean {
  if (!/^TASK-[0-9]{3}$/u.test(currentTaskId)) return false;
  const normalized = normalize(path);
  if (normalized === null) return false;
  return normalized === "implementation/progress.jsonl" || normalized.startsWith(`implementation/execution/${currentTaskId}/`);
}

function normalize(path: string): string | null {
  const slash = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (slash.startsWith("/") || /^[A-Za-z]:\//u.test(slash) || slash.includes("\0")) return null;
  const normalized = posix.normalize(slash);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}
