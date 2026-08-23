export type AuditDepth = "fast" | "balanced" | "deep";
export interface DiscoveryModule { readonly id: string; readonly files: readonly string[] }
export interface DiscoveryHotspot { readonly path: string; readonly score: number; readonly rank: number }
export interface AuditorScope { readonly auditorId: string; readonly moduleIds: readonly string[]; readonly files: readonly string[]; readonly overlapModuleIds: readonly string[] }

const SECURITY_SURFACE = /(?:auth(?:entication|orization)?|tenant|permission|security|secret|crypto|billing|payment|migration|deploy|integrity)/iu;

export function allocateDiscoveryScopes(depth: AuditDepth, auditorIds: readonly string[], modules: readonly DiscoveryModule[], hotspots: readonly DiscoveryHotspot[]): readonly AuditorScope[] {
  if (auditorIds.length === 0 || new Set(auditorIds).size !== auditorIds.length) throw new Error("INVALID_DISCOVERY_AUDITORS");
  const ordered = [...modules].sort((a, b) => a.id.localeCompare(b.id));
  const hotspotPaths = new Set([...hotspots].sort((a, b) => a.rank - b.rank || b.score - a.score).slice(0, Math.max(1, Math.ceil(hotspots.length / 4))).map(({ path }) => path));
  const security = ordered.filter((module) => SECURITY_SURFACE.test(module.id) || module.files.some((path) => SECURITY_SURFACE.test(path)));
  const hotspot = ordered.filter((module) => module.files.some((path) => hotspotPaths.has(path)));
  const minimum = security.length > 0 ? security : hotspot.slice(0, 1);
  const overlap = depth === "deep" ? ordered : depth === "balanced" ? uniqueModules([...minimum, ...hotspot]) : minimum;
  const overlapIds = new Set(overlap.map(({ id }) => id));
  const partitioned = ordered.filter(({ id }) => !overlapIds.has(id));
  return Object.freeze(auditorIds.map((auditorId, index) => {
    const selected = depth === "deep" ? ordered : [...overlap, ...partitioned.filter((_module, moduleIndex) => moduleIndex % auditorIds.length === index)];
    return Object.freeze({ auditorId, moduleIds: Object.freeze(selected.map(({ id }) => id)), files: Object.freeze([...new Set(selected.flatMap(({ files }) => files))].sort()), overlapModuleIds: Object.freeze(overlap.map(({ id }) => id)) });
  }));
}

function uniqueModules(modules: readonly DiscoveryModule[]): DiscoveryModule[] { const seen = new Set<string>(); return modules.filter(({ id }) => !seen.has(id) && Boolean(seen.add(id))); }
