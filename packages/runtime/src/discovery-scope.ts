import { approximateModules } from "@arbitra/core/preflight/modules.js";
import type { RepositorySnapshot, SourceFile } from "./repository.js";

export interface DiscoveryScope {
  readonly files: readonly SourceFile[];
  readonly splitModules: readonly string[];
}

/** Module-first packing. An oversized module is split into whole files and the
 * lost joint context is recorded explicitly. No file is silently truncated. */
export function allocateDiscoveryScopes(snapshot: RepositorySnapshot, fits: (files: readonly SourceFile[]) => boolean): { scopes: readonly DiscoveryScope[]; unallocatedPaths: readonly string[] } {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const modules = approximateModules(snapshot.files.map(({ path, lines }) => ({ path, content: lines.join("\n") })));
  const grouped = new Set(modules.flatMap(({ files }) => files));
  const groups = [...modules.map((module) => ({ id: module.id, files: module.files.flatMap((path) => { const file = files.get(path); return file === undefined ? [] : [file]; }) })),
    ...snapshot.files.filter(({ path }) => !grouped.has(path)).map((file) => ({ id: file.path, files: [file] }))].sort((a, b) => a.id.localeCompare(b.id));
  const scopes: DiscoveryScope[] = []; const unallocatedPaths: string[] = [];
  let pending: SourceFile[] = []; let splitModules: string[] = [];
  const flush = () => { if (pending.length > 0) scopes.push({ files: pending, splitModules: [...new Set(splitModules)] }); pending = []; splitModules = []; };
  for (const group of groups) {
    if (fits([...pending, ...group.files])) { pending.push(...group.files); continue; }
    flush();
    if (fits(group.files)) { pending = [...group.files]; continue; }
    for (const file of group.files) {
      if (!fits([file])) { unallocatedPaths.push(file.path); continue; }
      if (!fits([...pending, file])) flush();
      pending.push(file); splitModules.push(group.id);
    }
    flush();
  }
  flush();
  return { scopes, unallocatedPaths: unallocatedPaths.sort() };
}
