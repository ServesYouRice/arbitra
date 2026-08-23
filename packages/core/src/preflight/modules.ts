import { posix } from "node:path";

export interface ModuleSourceFile {
  readonly path: string;
  readonly content?: string;
}

export interface ApproximatedModule {
  readonly id: string;
  readonly files: readonly string[];
  readonly evidence: readonly string[];
}

export interface ModuleApproximationStrategy {
  partition(files: readonly ModuleSourceFile[]): readonly ApproximatedModule[];
}

export const importTopologyStrategy: ModuleApproximationStrategy = {
  partition: approximateModules,
};

export function approximateModules(files: readonly ModuleSourceFile[]): readonly ApproximatedModule[] {
  const sourceFiles = files
    .filter(({ path }) => isSourceFile(path))
    .map(({ path, content }) => ({ path: normalize(path), content: content ?? "" }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set(sourceFiles.map(({ path }) => path));
  const parents = new Map(sourceFiles.map(({ path }) => [path, path]));
  const evidence = new Map<string, Set<string>>();

  for (const file of sourceFiles) {
    for (const specifier of extractEdges(file.content)) {
      const target = resolveSpecifier(file.path, specifier, paths);
      if (target !== null) {
        union(parents, file.path, target);
        addEvidence(evidence, file.path, `import:${specifier}`);
        addEvidence(evidence, target, `imported-by:${file.path}`);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const root = find(parents, file.path);
    const group = groups.get(root) ?? [];
    group.push(file.path);
    groups.set(root, group);
  }

  return Object.freeze([...groups.values()].map((group) => {
    const sorted = group.sort();
    const id = commonModuleName(sorted);
    return Object.freeze({
      id,
      files: Object.freeze(sorted),
      evidence: Object.freeze([...new Set(sorted.flatMap((path) => [...(evidence.get(path) ?? [])]))].sort()),
    });
  }).sort((left, right) => left.id.localeCompare(right.id)));
}

function extractEdges(content: string): readonly string[] {
  const values: string[] = [];
  const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|(?:route|register|use)\(\s*["']([^"']+)["']/gu;
  for (const match of content.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function resolveSpecifier(from: string, specifier: string, paths: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const withoutRuntimeExtension = base.replace(/\.(?:mjs|cjs|js|jsx)$/u, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    `${withoutRuntimeExtension}.ts`, `${withoutRuntimeExtension}.tsx`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}

function isSourceFile(path: string): boolean {
  return /\.(?:c|m)?(?:js|ts)x?$|\.(?:py|rb|go|rs|java|kt|cs)$/u.test(path);
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function find(parents: Map<string, string>, value: string): string {
  const parent = parents.get(value);
  if (parent === undefined) throw new Error(`UNKNOWN_MODULE_FILE:${value}`);
  if (parent === value) return value;
  const root = find(parents, parent);
  parents.set(value, root);
  return root;
}

function union(parents: Map<string, string>, left: string, right: string): void {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot < rightRoot ? leftRoot : rightRoot);
  if (leftRoot > rightRoot) parents.set(leftRoot, rightRoot);
}

function addEvidence(target: Map<string, Set<string>>, path: string, value: string): void {
  const entries = target.get(path) ?? new Set<string>();
  entries.add(value);
  target.set(path, entries);
}

function commonModuleName(files: readonly string[]): string {
  const parts = files.map((file) => file.split("/"));
  let length = 0;
  const maximum = Math.min(...parts.map((part) => part.length));
  while (length < maximum && parts.every((part) => part[length] === parts[0]?.[length])) length += 1;
  const prefix = parts[0]?.slice(0, Math.max(1, length)).join("/") ?? "module";
  return prefix.replace(/\.[^.]+$/u, "") || "module";
}
