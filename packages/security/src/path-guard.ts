import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type AbsolutePath = string & { readonly __absolutePath: unique symbol };

export function resolveInsideRoot(root: string, candidate: string): AbsolutePath {
  if (candidate.includes("\0")) throw new PathOutsideRootError(candidate);
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(absoluteRoot, candidate);
  const fromRoot = relative(absoluteRoot, absoluteCandidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${separatorFor(fromRoot)}`) || isAbsolute(fromRoot)) {
    throw new PathOutsideRootError(candidate);
  }
  return absoluteCandidate as AbsolutePath;
}

function separatorFor(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export class PathOutsideRootError extends Error {
  constructor(candidate: string) {
    super(`Path resolves outside the repository root: ${candidate}`);
    this.name = "PathOutsideRootError";
  }
}

/** The sole filesystem-read entry point for repository content in this package. */
export class RepositoryPathGuard {
  private constructor(
    readonly root: AbsolutePath,
    private readonly canonicalRoot: AbsolutePath,
  ) {}

  static async create(root: string): Promise<RepositoryPathGuard> {
    const absoluteRoot = resolve(root) as AbsolutePath;
    const canonicalRoot = (await realpath(absoluteRoot)) as AbsolutePath;
    return new RepositoryPathGuard(absoluteRoot, canonicalRoot);
  }

  resolve(candidate: string): AbsolutePath {
    return resolveInsideRoot(this.root, candidate);
  }

  async readFile(candidate: string, encoding: BufferEncoding = "utf8"): Promise<string> {
    const path = await this.resolveExisting(candidate);
    return readFile(path, encoding);
  }

  async stat(candidate: string): Promise<{ readonly size: number; readonly mtimeMs: number }> {
    const path = await this.resolveExisting(candidate);
    const result = await stat(path);
    return Object.freeze({ size: result.size, mtimeMs: result.mtimeMs });
  }

  private async resolveExisting(candidate: string): Promise<AbsolutePath> {
    const lexical = this.resolve(candidate);
    const canonical = (await realpath(lexical)) as AbsolutePath;
    resolveInsideRoot(this.canonicalRoot, canonical);
    return canonical;
  }
}
