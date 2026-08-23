import { describe, expect, it } from "vitest";

import { complexityGate } from "../../src/preflight/complexity-gate.js";
import { rankHotspots } from "../../src/preflight/hotspots.js";
import { approximateModules } from "../../src/preflight/modules.js";
import { preflight, type PreflightSnapshot } from "../../src/preflight/project-context.js";

const fixtureSnapshot: PreflightSnapshot = {
  root: "/fixture",
  branch: "main",
  commit: "abc123",
  dirty: false,
  changedFiles: [],
  scope: { kind: "full" },
  ignoredPaths: ["dist"],
  gitLog: [
    "\u001eaaa\u001fAda\u001f2026-08-20T10:00:00Z\u001ffix auth bug\u001fapps/api/src/auth.ts\npackages/shared/src/token.ts",
    "\u001ebbb\u001fLin\u001f2026-08-10T10:00:00Z\u001fadd auth\u001fapps/api/src/auth.ts",
  ].join(""),
  files: [
    file("package.json", JSON.stringify({
      name: "fixture",
      scripts: { build: "tsc", lint: "eslint .", typecheck: "tsc --noEmit" },
      devDependencies: { vitest: "1.0.0" },
      workspaces: ["apps/*", "packages/*"],
    })),
    file("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*"),
    file("pnpm-lock.yaml", "packages:\n  vitest:\n    version: 1.0.0"),
    file("apps/api/package.json", JSON.stringify({ name: "@fixture/api", dependencies: { fastify: "1.0.0" } })),
    file("apps/api/src/auth.ts", "import { token } from '../../../packages/shared/src/token.js';\nexport const auth = token;", "2026-08-20T10:00:00Z"),
    file("packages/shared/src/token.ts", "export const token = 'x';", "2026-08-19T10:00:00Z"),
    file("apps/api/test/auth.test.ts", "import '../src/auth.js';\ntest('auth', () => {});"),
    file("vitest.config.ts", "export default {};"),
    file(".github/workflows/ci.yml", "name: ci"),
    file("apps/api/Dockerfile", "FROM node:22"),
  ],
};

describe("repository preflight", () => {
  it("captures the deterministic project context and emits serialisable artifacts", () => {
    const result = preflight(fixtureSnapshot, {
      configuredExclusions: ["generated/**"],
      gate: {
        riskCategory: "high",
        securitySensitiveSurfaceCount: 1,
        migrationInvolvement: false,
        architectureBreadth: 3,
        testingComplexity: 2,
        instructionRiskDensity: 0,
        userSelectedThoroughness: null,
        configuredModelCount: 3,
        budget: 100,
      },
    });

    expect(result.projectContext).toMatchObject({
      repository: { commit: "abc123", dirty: false },
      frameworks: ["fastify", "vitest"],
      testDirectories: ["apps/api/test"],
      testConfiguration: ["vitest.config.ts"],
      ciConfiguration: [".github/workflows/ci.yml"],
      deploymentConfiguration: ["apps/api/Dockerfile"],
      configuredExclusions: ["generated/**"],
    });
    expect(result.projectContext.commands).toEqual({
      build: ["package.json: tsc"],
      lint: ["package.json: eslint ."],
      typecheck: ["package.json: tsc --noEmit"],
    });
    expect(result.projectContext.workspaces).toEqual(["@fixture/api", "fixture", "pnpm-workspace.yaml"]);
    expect(result.projectContext.languages.TypeScript).toEqual({ files: 4, loc: 6 });
    expect(() => JSON.stringify(result.projectContext)).not.toThrow();
    expect(() => JSON.stringify(result.hotspots)).not.toThrow();
    expect(result.intensity.inputs.fileCount).toBe(10);
  });

  it("keeps a cross-directory call chain in one module", () => {
    const modules = approximateModules(fixtureSnapshot.files);
    const authModule = modules.find(({ files }) => files.includes("apps/api/src/auth.ts"));
    expect(authModule?.files).toContain("packages/shared/src/token.ts");
    expect(authModule?.evidence).toContain("import:../../../packages/shared/src/token.js");
  });

  it("ranks raw hotspot facts from one log result", () => {
    const hotspots = rankHotspots(fixtureSnapshot.gitLog);
    expect(hotspots[0]).toMatchObject({
      path: "apps/api/src/auth.ts",
      churn: 2,
      authorSpread: 2,
      fixDensity: 0.5,
      rank: 1,
    });
  });

  it("returns its inputs and preserves an explicit intensity", () => {
    const result = complexityGate({
      scopeSize: 1_000_000,
      fileCount: 1_000,
      languageCount: 8,
      serviceCount: 5,
      riskCategory: "critical",
      securitySensitiveSurfaceCount: 5,
      migrationInvolvement: true,
      architectureBreadth: 10,
      testingComplexity: 10,
      hotspotDensity: 1,
      instructionRiskDensity: 1,
      userSelectedThoroughness: "FAST",
      configuredModelCount: 4,
      budget: 1_000,
    });
    expect(result.recommended).toBe("DEEP");
    expect(result.effective).toBe("FAST");
    expect(result.explicitConfigurationPreserved).toBe(true);
    expect(result.inputs.fileCount).toBe(1_000);
    expect(result.reasons).toContain("explicit FAST configuration preserved");
  });
});

function file(path: string, content: string, modifiedAt?: string) {
  return {
    path,
    content,
    size: Buffer.byteLength(content),
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
  };
}
