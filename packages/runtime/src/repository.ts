import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface SourceFile {
  readonly path: string;
  readonly lines: readonly string[];
  readonly byteLength: number;
  readonly lineStartBytes: readonly number[];
}

export interface RepositorySnapshot {
  readonly root: string;
  readonly files: readonly SourceFile[];
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".pnpm-store", ".runs", ".vite"]);
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const MAXIMUM_FILE_BYTES = 512 * 1024;

/**
 * A read-only snapshot of the repository's source files.
 *
 * Audit and Feature modes are read-only (spec §2.1), so this only ever reads. Line start
 * offsets are carried because finding validation checks every cited line against them.
 */
export async function snapshotRepository(root: string, maximumFiles = 400): Promise<RepositorySnapshot> {
  const paths: string[] = [];
  await walk(root, root, paths, maximumFiles);
  const files = await Promise.all(paths.sort().slice(0, maximumFiles).map(async (path): Promise<SourceFile> => {
    const text = await readFile(join(root, path), "utf8");
    const lines = text.split("\n");
    const lineStartBytes: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineStartBytes.push(offset);
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
    return Object.freeze({ path, lines: Object.freeze(lines), byteLength: Buffer.byteLength(text, "utf8"), lineStartBytes: Object.freeze(lineStartBytes) });
  }));
  return Object.freeze({ root, files: Object.freeze(files) });
}

async function walk(root: string, directory: string, into: string[], limit: number): Promise<void> {
  if (into.length >= limit) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (into.length >= limit) return;
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(root, full, into, limit);
      continue;
    }
    if (!SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    const info = await stat(full);
    if (info.size > MAXIMUM_FILE_BYTES) continue;
    into.push(relative(root, full).split(sep).join("/"));
  }
}
