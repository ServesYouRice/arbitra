import { extname, posix } from "node:path";

import {
  complexityGate,
  type ComplexityGateInputs,
  type IntensityRecommendation,
} from "./complexity-gate.js";
import { rankHotspots, type Hotspot } from "./hotspots.js";
import { approximateModules, type ApproximatedModule } from "./modules.js";

export interface SnapshotFile {
  readonly path: string;
  readonly content?: string;
  readonly size: number;
  readonly modifiedAt?: string;
  readonly ignored?: boolean;
}

export interface PreflightSnapshot {
  readonly root: string;
  readonly branch: string | null;
  readonly commit: string;
  readonly dirty: boolean;
  readonly changedFiles: readonly string[];
  readonly scope: Readonly<{ kind: "full" } | { kind: "diff"; base: string; head: string; mergeBase: string }>;
  readonly files: readonly SnapshotFile[];
  /** Output captured from exactly one deterministic git-log activity. */
  readonly gitLog: string;
  readonly ignoredPaths: readonly string[];
}

export interface ProjectContext {
  readonly repository: {
    readonly root: string;
    readonly branch: string | null;
    readonly commit: string;
    readonly dirty: boolean;
    readonly changedFiles: readonly string[];
    readonly scope: PreflightSnapshot["scope"];
  };
  readonly languages: Readonly<Record<string, { readonly files: number; readonly loc: number }>>;
  readonly packageManifests: readonly PackageManifestFact[];
  readonly lockfileDependencyCount: number;
  readonly frameworks: readonly string[];
  readonly workspaces: readonly string[];
  readonly likelyServices: readonly string[];
  readonly testDirectories: readonly string[];
  readonly testConfiguration: readonly string[];
  readonly testToSourceRatio: number;
  readonly commands: {
    readonly build: readonly string[];
    readonly lint: readonly string[];
    readonly typecheck: readonly string[];
  };
  readonly ciConfiguration: readonly string[];
  readonly deploymentConfiguration: readonly string[];
  readonly infrastructureFiles: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly configuredExclusions: readonly string[];
  readonly directoryRecency: Readonly<Record<string, string>>;
}

export interface PackageManifestFact {
  readonly path: string;
  readonly name: string | null;
  readonly dependencyCount: number;
  readonly scripts: Readonly<Record<string, string>>;
}

export interface PreflightConfig {
  readonly configuredExclusions: readonly string[];
  readonly gate: Omit<ComplexityGateInputs,
    "scopeSize" | "fileCount" | "languageCount" | "serviceCount" | "hotspotDensity">;
}

export interface PreflightResult {
  readonly projectContext: ProjectContext;
  readonly hotspots: readonly Hotspot[];
  readonly modules: readonly ApproximatedModule[];
  readonly intensity: IntensityRecommendation;
}

export function preflight(snapshot: PreflightSnapshot, config: PreflightConfig): PreflightResult {
  const projectContext = captureProjectContext(snapshot, config.configuredExclusions);
  const hotspots = rankHotspots(snapshot.gitLog);
  const modules = approximateModules(snapshot.files);
  const includedFiles = snapshot.files.filter(({ ignored }) => ignored !== true);
  const intensity = complexityGate({
    ...config.gate,
    scopeSize: includedFiles.reduce((total, file) => total + file.size, 0),
    fileCount: includedFiles.length,
    languageCount: Object.keys(projectContext.languages).length,
    serviceCount: projectContext.likelyServices.length,
    hotspotDensity: includedFiles.length === 0 ? 0 : hotspots.length / includedFiles.length,
  });
  return Object.freeze({ projectContext, hotspots, modules, intensity });
}

export function captureProjectContext(
  snapshot: PreflightSnapshot,
  configuredExclusions: readonly string[],
): ProjectContext {
  const files = snapshot.files.filter(({ ignored }) => ignored !== true);
  const manifests = files.flatMap((file) => manifestFact(file));
  const languages = languageInventory(files);
  const testFiles = files.filter(({ path }) => isTestPath(path));
  const sourceFiles = files.filter(({ path }) => isSourcePath(path) && !isTestPath(path));
  const packageNames = new Set(manifests.flatMap(({ name }) => name === null ? [] : [name]));
  const dependencyNames = new Set(manifests.flatMap((manifest) => {
    const file = files.find(({ path }) => path === manifest.path);
    return file?.content === undefined ? [] : dependenciesFromJson(file.content);
  }));

  return Object.freeze({
    repository: Object.freeze({
      root: snapshot.root,
      branch: snapshot.branch,
      commit: snapshot.commit,
      dirty: snapshot.dirty,
      changedFiles: Object.freeze([...snapshot.changedFiles].sort()),
      scope: snapshot.scope,
    }),
    languages: Object.freeze(languages),
    packageManifests: Object.freeze(manifests),
    lockfileDependencyCount: countLockfileDependencies(files),
    frameworks: Object.freeze(detectFrameworks(dependencyNames)),
    workspaces: Object.freeze(detectWorkspaces(files, packageNames)),
    likelyServices: Object.freeze(detectServices(files, manifests)),
    testDirectories: Object.freeze(uniqueSorted(testFiles.map(({ path }) => testDirectory(path)))),
    testConfiguration: Object.freeze(files.map(({ path }) => path).filter(isTestConfig).sort()),
    testToSourceRatio: sourceFiles.length === 0 ? 0 : round(testFiles.length / sourceFiles.length),
    commands: Object.freeze({
      build: Object.freeze(commandsFor(manifests, "build")),
      lint: Object.freeze(commandsFor(manifests, "lint")),
      typecheck: Object.freeze(commandsFor(manifests, "typecheck")),
    }),
    ciConfiguration: Object.freeze(files.map(({ path }) => path).filter(isCiConfig).sort()),
    deploymentConfiguration: Object.freeze(files.map(({ path }) => path).filter(isDeploymentConfig).sort()),
    infrastructureFiles: Object.freeze(files.map(({ path }) => path).filter(isInfrastructureFile).sort()),
    ignoredPaths: Object.freeze([...snapshot.ignoredPaths].sort()),
    configuredExclusions: Object.freeze([...configuredExclusions].sort()),
    directoryRecency: Object.freeze(directoryRecency(files)),
  });
}

function manifestFact(file: SnapshotFile): readonly PackageManifestFact[] {
  if (!/(?:^|\/)(?:package\.json|composer\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/u.test(file.path)) return [];
  if (!file.path.endsWith(".json") || file.content === undefined) {
    return [{ path: file.path, name: null, dependencyCount: 0, scripts: Object.freeze({}) }];
  }
  try {
    const value = JSON.parse(file.content) as Record<string, unknown>;
    const scripts = stringRecord(value["scripts"]);
    const dependencies = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .reduce((total, key) => total + Object.keys(stringRecord(value[key])).length, 0);
    return [{
      path: file.path,
      name: typeof value["name"] === "string" ? value["name"] : null,
      dependencyCount: dependencies,
      scripts: Object.freeze(scripts),
    }];
  } catch {
    return [{ path: file.path, name: null, dependencyCount: 0, scripts: Object.freeze({}) }];
  }
}

function languageInventory(files: readonly SnapshotFile[]): Record<string, { files: number; loc: number }> {
  const result: Record<string, { files: number; loc: number }> = {};
  for (const file of files) {
    const language = extensionLanguages[extname(file.path).toLowerCase()];
    if (language === undefined) continue;
    const current = result[language] ?? { files: 0, loc: 0 };
    current.files += 1;
    current.loc += file.content === undefined ? 0 : file.content.split(/\r?\n/u).filter((line) => line.trim()).length;
    result[language] = current;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

const extensionLanguages: Readonly<Record<string, string>> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".rb": "Ruby", ".cs": "C#", ".css": "CSS", ".html": "HTML", ".sql": "SQL",
};

function dependenciesFromJson(content: string): readonly string[] {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((key) => Object.keys(stringRecord(value[key])));
  } catch { return []; }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function detectFrameworks(dependencies: ReadonlySet<string>): string[] {
  const known = ["@nestjs/core", "@remix-run/react", "@sveltejs/kit", "angular", "express", "fastify",
    "next", "nuxt", "react", "vue", "vitest", "jest", "playwright"];
  return known.filter((name) => dependencies.has(name));
}

function detectWorkspaces(files: readonly SnapshotFile[], packageNames: ReadonlySet<string>): string[] {
  const workspaceFiles = files.filter(({ path }) => /(?:^|\/)(?:pnpm-workspace\.yaml|lerna\.json|turbo\.json)$/u.test(path));
  return uniqueSorted([...workspaceFiles.map(({ path }) => path), ...packageNames]);
}

function detectServices(files: readonly SnapshotFile[], manifests: readonly PackageManifestFact[]): string[] {
  const servicePaths = files.map(({ path }) => path).filter((path) =>
    /(?:^|\/)(?:apps|services)\/[^/]+\/(?:package\.json|Dockerfile)$/u.test(path));
  const names = manifests.filter(({ path }) => /(?:^|\/)(?:apps|services)\//u.test(path))
    .flatMap(({ name, path }) => name ?? posix.basename(posix.dirname(path)));
  return uniqueSorted([...servicePaths.map((path) => posix.dirname(path)), ...names]);
}

function commandsFor(manifests: readonly PackageManifestFact[], name: string): string[] {
  return manifests.flatMap((manifest) => manifest.scripts[name] === undefined
    ? [] : [`${manifest.path}: ${manifest.scripts[name]}`]).sort();
}

function countLockfileDependencies(files: readonly SnapshotFile[]): number {
  return files.filter(({ path }) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock)$/u.test(path))
    .reduce((total, file) => total + (file.content?.match(/^\s{2,}(?:\/|["']?[^\s:#]+["']?):/gmu)?.length ?? 0), 0);
}

function isSourcePath(path: string): boolean { return extensionLanguages[extname(path).toLowerCase()] !== undefined; }
function isTestPath(path: string): boolean { return /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^.]+$/u.test(path); }
function testDirectory(path: string): string { const match = path.match(/^(.*?(?:test|tests|__tests__))(?:\/|$)/u); return match?.[1] ?? posix.dirname(path); }
function isTestConfig(path: string): boolean { return /(?:vitest|jest|playwright|pytest|phpunit|cypress)(?:\.config)?\./u.test(path); }
function isCiConfig(path: string): boolean { return /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\/|^azure-pipelines\.yml$/u.test(path); }
function isDeploymentConfig(path: string): boolean { return /(?:^|\/)(?:Dockerfile|docker-compose[^/]*\.ya?ml|vercel\.json|netlify\.toml|fly\.toml|render\.yaml|k8s\/|helm\/)/u.test(path); }
function isInfrastructureFile(path: string): boolean { return /(?:^|\/)(?:Dockerfile|[^/]+\.tf|Pulumi\.[^/]+|serverless\.ya?ml|k8s\/|helm\/)/u.test(path); }

function directoryRecency(files: readonly SnapshotFile[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of files) {
    if (file.modifiedAt === undefined) continue;
    const directory = posix.dirname(file.path);
    if (result[directory] === undefined || file.modifiedAt > result[directory]) result[directory] = file.modifiedAt;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
