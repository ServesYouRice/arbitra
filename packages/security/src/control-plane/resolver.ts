import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  CONTROL_PLANE_ASSETS,
  CONTROL_PLANE_PATHS,
  type ControlPlaneAssetId,
  type ControlPlaneSource,
} from "./assets.js";

const execFileAsync = promisify(execFile);

export interface ControlPlaneScope {
  readonly repositoryRoot: string;
  /** Revision whose rules are authoritative for this run. */
  readonly trustedBaseRevision: string;
  /** Untrusted revision under audit. Omit only for a full/dirty-tree audit. */
  readonly auditedRevision?: string;
  /** Changed paths already captured by the immutable repository snapshot. */
  readonly changedPaths?: readonly string[];
}

export type ExternalControlPlane = Partial<Readonly<Record<ControlPlaneAssetId, string>>>;

export interface ControlPlaneReader {
  readAtRevision(root: string, revision: string, path: string): Promise<string | null>;
  changedPaths(root: string, base: string, head: string): Promise<readonly string[]>;
}

export interface ControlPlaneResolverConfig {
  readonly external?: ExternalControlPlane;
  readonly reader?: ControlPlaneReader;
}

export interface ResolvedControlPlaneAsset {
  readonly assetId: ControlPlaneAssetId;
  readonly repositoryPath: string;
  readonly content: string;
  readonly source: ControlPlaneSource;
  readonly sourceRevision: string | null;
}

export interface ControlPlaneAuditSubject {
  readonly assetId: ControlPlaneAssetId;
  readonly path: string;
  readonly disposition: "recorded_not_applied";
  readonly note: string;
}

export interface ResolvedControlPlaneArtifact {
  readonly version: 1;
  readonly trustedBaseRevision: string;
  readonly sources: Readonly<Record<ControlPlaneAssetId, ControlPlaneSource>>;
  readonly auditSubjects: readonly ControlPlaneAuditSubject[];
}

export interface ResolvedControlPlane {
  readonly assets: Readonly<Record<ControlPlaneAssetId, ResolvedControlPlaneAsset>>;
  readonly auditSubjects: readonly ControlPlaneAuditSubject[];
  readonly artifact: ResolvedControlPlaneArtifact;
  sourceOf(assetId: ControlPlaneAssetId): ControlPlaneSource;
}

const gitReader: ControlPlaneReader = {
  async readAtRevision(root, revision, path) {
    try {
      const result = await execFileAsync("git", ["-C", root, "show", `${revision}:${path}`], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      if (isMissingGitObject(error)) return null;
      throw error;
    }
  },
  async changedPaths(root, base, head) {
    const result = await execFileAsync("git", ["-C", root, "diff", "--name-only", "-z", base, head], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout.split("\0").filter((path) => path.length > 0);
  },
};

export async function resolveControlPlane(
  scope: ControlPlaneScope,
  config: ControlPlaneResolverConfig = {},
): Promise<ResolvedControlPlane> {
  if (scope.trustedBaseRevision.trim().length === 0) {
    throw new Error("A trusted base revision is required to resolve the control plane.");
  }

  const reader = config.reader ?? gitReader;
  const changedPaths = scope.changedPaths ?? (
    scope.auditedRevision === undefined
      ? []
      : await reader.changedPaths(
          scope.repositoryRoot,
          scope.trustedBaseRevision,
          scope.auditedRevision,
        )
  );
  const changedSet = new Set(changedPaths.map(normalizePath));
  const assets = {} as Record<ControlPlaneAssetId, ResolvedControlPlaneAsset>;
  const sources = {} as Record<ControlPlaneAssetId, ControlPlaneSource>;
  const auditSubjects: ControlPlaneAuditSubject[] = [];

  for (const definition of CONTROL_PLANE_ASSETS) {
    const externalContent = config.external?.[definition.id];
    const baseContent = externalContent === undefined
      ? await reader.readAtRevision(
          scope.repositoryRoot,
          scope.trustedBaseRevision,
          definition.repositoryPath,
        )
      : null;
    const source: ControlPlaneSource = externalContent !== undefined
      ? "external_config"
      : baseContent !== null
        ? "trusted_base"
        : "default";
    const content = externalContent ?? baseContent ?? definition.defaultContent;
    const resolved = Object.freeze({
      assetId: definition.id,
      repositoryPath: definition.repositoryPath,
      content,
      source,
      sourceRevision: source === "trusted_base" ? scope.trustedBaseRevision : null,
    });
    assets[definition.id] = resolved;
    sources[definition.id] = source;

    if (changedSet.has(definition.repositoryPath)) {
      auditSubjects.push(Object.freeze({
        assetId: definition.id,
        path: definition.repositoryPath,
        disposition: "recorded_not_applied" as const,
        note: "The head-side control-plane change did not take effect for this run; it may become active after entering the trusted base.",
      }));
    }
  }

  const frozenAssets = Object.freeze(assets);
  const frozenSubjects = Object.freeze(auditSubjects);
  const artifact = Object.freeze({
    version: 1 as const,
    trustedBaseRevision: scope.trustedBaseRevision,
    sources: Object.freeze(sources),
    auditSubjects: frozenSubjects,
  });

  return Object.freeze({
    assets: frozenAssets,
    auditSubjects: frozenSubjects,
    artifact,
    sourceOf(assetId: ControlPlaneAssetId) {
      return frozenAssets[assetId].source;
    },
  });
}

export function isControlPlanePath(path: string): boolean {
  return CONTROL_PLANE_PATHS.has(normalizePath(path));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isMissingGitObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return false;
  const stderr = String(error.stderr);
  return /(?:does not exist in|exists on disk, but not in|invalid object name)/u.test(stderr);
}

