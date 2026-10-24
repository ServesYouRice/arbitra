import { describe, expect, it } from "vitest";
import { expandImpactedSurfaces } from "../../src/preflight/impacted-surfaces.js";

describe("impacted surface expansion", () => {
  it("uses bounded deterministic relations and explains every included surface", () => {
    const report = expandImpactedSurfaces(["src/auth.ts"], [
      { id: "auth", files: ["src/auth.ts"], relations: [] },
      { id: "routes", files: ["src/routes.ts"], relations: [{ from: "src/auth.ts", to: "src/routes.ts", kind: "route" }] },
      { id: "unrelated", files: ["src/catalog.ts"], relations: [] },
    ]);
    expect(report.surfaces.map(({ surfaceId }) => surfaceId)).toEqual(["auth", "routes"]);
    expect(report.surfaces.every(({ reasons }) => reasons.length > 0)).toBe(true);
    expect(report.surfaces[1]?.reasons).toEqual(["route:src/auth.ts->src/routes.ts"]);
  });
});
