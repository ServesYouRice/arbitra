import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { renderAgentEntrypoint, renderProviderAdapter } from "./entrypoints/index.js";
import { assertImplementationManifest, type ImplementationManifest, type ManifestTask } from "./manifest.js";
import { renderArchitectureContext, renderExecutionReadme, renderInvariantContext, renderIssue, renderProjectContext, renderReadme, renderRequirements, renderTask, renderTaskIndex, renderValidation } from "./markdown/index.js";

export type RenderedTree = Readonly<Record<string, string>>;
export interface RenderOptions {
  readonly selectedTaskId?: string;
  readonly adapters?: readonly ("claude" | "gemini")[];
  readonly effectiveWriteScopes: Readonly<Record<string, readonly string[]>>;
  readonly effectiveReadScopes?: Readonly<Record<string, readonly string[]>>;
}

export function renderImplementation(manifest: ImplementationManifest, options: RenderOptions): RenderedTree {
  assertImplementationManifest(manifest);
  const selected = selectTask(manifest, options.selectedTaskId);
  const entries: [string, string][] = [];
  const emit = (path: string, content: string) => entries.push([path, content]);
  const scopes = new Map(manifest.tasks.map((task) => [task.id, scopeFor(task, options)]));

  emit("manifest.json", `${stableJson(manifest)}\n`);
  emit("README.md", renderReadme(manifest));
  const selectedScope = scopes.get(selected.id) ?? { write: [], read: [] };
  emit("AGENTS.md", renderAgentEntrypoint(manifest, selected, selectedScope.write, selectedScope.read));
  if (options.adapters?.includes("claude")) emit("CLAUDE.md", renderProviderAdapter("Claude Code", selected));
  if (options.adapters?.includes("gemini")) emit("GEMINI.md", renderProviderAdapter("Gemini", selected));
  emit("context/project.md", renderProjectContext(manifest));
  emit("context/architecture.md", renderArchitectureContext(manifest));
  emit("context/invariants.md", renderInvariantContext(manifest));
  emit("context/requirements.md", renderRequirements(manifest));
  for (const issue of [...(manifest.issues ?? [])].sort((left, right) => left.id.localeCompare(right.id))) emit(`issues/${issue.id}.md`, renderIssue(issue));
  emit("issues/README.md", manifest.issues?.length ? "# Canonical issues\n\nSee the ID-named issue files in this directory.\n" : "# Canonical issues\n\nNo canonical issues were recorded.\n");
  emit("tasks/INDEX.md", renderTaskIndex(manifest));
  for (const task of [...manifest.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    const scope = scopes.get(task.id) ?? { write: [], read: [] };
    emit(`tasks/${task.id}/task.md`, renderTask(task, scope.write, scope.read));
  }
  emit("validation/final-validation.md", renderValidation(manifest));
  emit("execution/README.md", renderExecutionReadme(manifest));
  emit("progress.schema.json", `${stableJson(manifest.progressSchema)}\n`);
  emit("progress.jsonl", "");
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}

export function writeImplementation(tree: RenderedTree, directory: string): void {
  const root = resolve(directory);
  for (const [relative, content] of Object.entries(tree).sort(([left], [right]) => left.localeCompare(right))) {
    if (!safeRelative(relative)) throw new Error(`UNSAFE_RENDER_PATH:${relative}`);
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`RENDER_PATH_OUTSIDE_ROOT:${relative}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

function selectTask(manifest: ImplementationManifest, selected?: string): ManifestTask {
  const task = selected === undefined ? [...manifest.tasks].sort((left, right) => left.id.localeCompare(right.id))[0] : manifest.tasks.find(({ id }) => id === selected);
  if (task === undefined) throw new Error(`UNKNOWN_SELECTED_TASK:${selected ?? "none"}`);
  return task;
}

function scopeFor(task: ManifestTask, options: RenderOptions): { write: readonly string[]; read: readonly string[] } {
  const excluded = task.filesNotToTouch ?? [];
  const proposed = task.scope.likelyFiles;
  const write = unique((options.effectiveWriteScopes[task.id] ?? []).filter((path) => safeRelative(path) && proposed.some((pattern) => matches(pattern, path)) && !excluded.some((pattern) => matches(pattern, path))));
  const proposedRead = options.effectiveReadScopes?.[task.id] ?? task.readFirst;
  const read = unique(proposedRead.filter(safeRelative));
  return Object.freeze({ write: Object.freeze(write), read: Object.freeze(read) });
}

function matches(pattern: string, path: string): boolean {
  const normalizedPattern = normalize(pattern); const normalizedPath = normalize(path);
  if (normalizedPattern.endsWith("/**")) return normalizedPath.startsWith(normalizedPattern.slice(0, -3).replace(/\/$/u, "") + "/") || normalizedPath === normalizedPattern.slice(0, -3);
  if (normalizedPattern.endsWith("/")) return normalizedPath.startsWith(normalizedPattern);
  return normalizedPattern === normalizedPath;
}
function safeRelative(path: string): boolean { const value = normalize(path); return value.length > 0 && !value.startsWith("/") && !/^[A-Za-z]:\//u.test(value) && !value.split("/").includes(".."); }
function normalize(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/"); }
function unique(values: readonly string[]): string[] { return [...new Set(values.map(normalize))].sort(); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`; return JSON.stringify(value); }

export * from "./execution-state.js";
export * from "./manifest.js";
export * from "./markdown/neutralize.js";
export * from "./progress.js";
