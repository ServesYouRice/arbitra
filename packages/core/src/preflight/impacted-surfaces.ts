export type ImpactRelation = "import" | "dependency" | "route" | "test" | "manifest" | "schema" | "migration" | "module_topology";
export interface ImpactedModule { readonly id: string; readonly files: readonly string[]; readonly relations: readonly { readonly from: string; readonly to: string; readonly kind: ImpactRelation }[] }
export interface ImpactedSurface { readonly surfaceId: string; readonly paths: readonly string[]; readonly reasons: readonly string[] }
export interface ImpactedSurfaceReport { readonly changedPaths: readonly string[]; readonly surfaces: readonly ImpactedSurface[] }

export function expandImpactedSurfaces(changed: readonly string[], modules: readonly ImpactedModule[]): ImpactedSurfaceReport {
  const changedPaths = [...new Set(changed.map(normalize))].sort(); const changedSet = new Set(changedPaths); const included = new Map<string, Set<string>>();
  for (const module of modules) {
    const direct = module.files.map(normalize).filter((path) => changedSet.has(path)); if (direct.length > 0) add(included, module.id, direct.map((path) => `changed_file:${path}`));
    for (const relation of module.relations) {
      const from = normalize(relation.from); const to = normalize(relation.to);
      if (changedSet.has(from) || changedSet.has(to)) add(included, module.id, [`${relation.kind}:${changedSet.has(from) ? from : to}->${changedSet.has(from) ? to : from}`]);
    }
  }
  const surfaces = modules.filter(({ id }) => included.has(id)).map((module) => Object.freeze({ surfaceId: module.id, paths: Object.freeze([...module.files].map(normalize).sort()), reasons: Object.freeze([...(included.get(module.id) ?? [])].sort()) }));
  return Object.freeze({ changedPaths: Object.freeze(changedPaths), surfaces: Object.freeze(surfaces) });
}
function add(values: Map<string, Set<string>>, id: string, reasons: readonly string[]): void { const current = values.get(id) ?? new Set<string>(); for (const reason of reasons) current.add(reason); values.set(id, current); }
function normalize(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//u, ""); }
