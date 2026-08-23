export interface SelectedSurface { readonly id: string; readonly paths: readonly string[]; readonly hotspotScore: number; readonly riskCategories: readonly string[] }
export interface SurfaceInspection { readonly reads: readonly { readonly path: string }[]; readonly modulesTouched: readonly string[] }
export interface UnexaminedSurface { readonly surfaceId: string; readonly paths: readonly string[]; readonly weight: "critical" | "high" | "medium" | "low"; readonly riskScore: number; readonly reasons: readonly string[] }
export interface SecurityConsensusSections<TSuppression, TCoverage> { readonly suppressionCandidates: readonly TSuppression[]; readonly securityCoverage: TCoverage; readonly unexaminedSurfaces: readonly UnexaminedSurface[] }

export function unexaminedSurfaces(selected: readonly SelectedSurface[], inspections: readonly SurfaceInspection[]): readonly UnexaminedSurface[] {
  const readPaths = new Set(inspections.flatMap(({ reads }) => reads.map(({ path }) => normalize(path)))); const touched = new Set(inspections.flatMap(({ modulesTouched }) => modulesTouched));
  const values = selected.filter((surface) => !touched.has(surface.id) && !surface.paths.some((path) => readPaths.has(normalize(path)))).map((surface) => {
    const categories = surface.riskCategories.map((value) => value.toLocaleLowerCase("en-US")); const securityCritical = categories.some((value) => /auth|tenant|billing|payment|migration|security|integrity/u.test(value)); const riskScore = round(Math.max(surface.hotspotScore, securityCritical ? 0.9 : categories.length > 0 ? 0.6 : 0.2)); const weight = riskScore >= 0.9 ? "critical" : riskScore >= 0.7 ? "high" : riskScore >= 0.4 ? "medium" : "low";
    return Object.freeze({ surfaceId: surface.id, paths: Object.freeze([...surface.paths].sort()), weight, riskScore, reasons: Object.freeze([...(securityCritical ? ["security_sensitive_category"] : []), ...(surface.hotspotScore >= 0.7 ? ["high_hotspot_score"] : []), "not_present_in_any_inspection_footprint"]) });
  }).sort((a, b) => b.riskScore - a.riskScore || a.surfaceId.localeCompare(b.surfaceId));
  return Object.freeze(values);
}
export function securityConsensusSections<TSuppression, TCoverage>(suppression: readonly TSuppression[], coverage: TCoverage, unexamined: readonly UnexaminedSurface[]): SecurityConsensusSections<TSuppression, TCoverage> { return Object.freeze({ suppressionCandidates: Object.freeze([...suppression]), securityCoverage: coverage, unexaminedSurfaces: Object.freeze([...unexamined]) }); }
export function renderSecurityCoverageText(sections: SecurityConsensusSections<unknown, { readonly degraded: boolean; readonly reason: string | null }>): string { return [`Suppression candidates: ${sections.suppressionCandidates.length}`, `Security coverage: ${sections.securityCoverage.degraded ? `degraded (${sections.securityCoverage.reason ?? "unspecified"})` : "complete"}`, `Unexamined surfaces: ${sections.unexaminedSurfaces.length}`].join("\n"); }
function normalize(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//u, ""); }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
