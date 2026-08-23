import { describe, expect, it } from "vitest";

import { createExclusionPolicy, isExcluded } from "../../src/exclusions.js";
import {
  CONTROL_PLANE_ASSETS,
  type ControlPlaneAssetId,
} from "../../src/control-plane/assets.js";
import {
  resolveControlPlane,
  type ControlPlaneReader,
} from "../../src/control-plane/resolver.js";

describe("trusted control-plane resolution", () => {
  it("resolves every enumerated asset and records its source in the run artifact", async () => {
    const baseFiles = Object.fromEntries(
      CONTROL_PLANE_ASSETS.map((asset) => [asset.repositoryPath, `base:${asset.id}`]),
    );
    const reader = new FakeControlPlaneReader(baseFiles);

    const resolved = await resolveControlPlane(scope(), {
      reader,
      external: { security_policy: "external security" },
    });

    for (const asset of CONTROL_PLANE_ASSETS) {
      const expected = asset.id === "security_policy" ? "external_config" : "trusted_base";
      expect(resolved.sourceOf(asset.id)).toBe(expected);
      expect(resolved.artifact.sources[asset.id]).toBe(expected);
      expect(resolved.assets[asset.id].content).toBe(
        asset.id === "security_policy" ? "external security" : `base:${asset.id}`,
      );
    }
    expect(reader.readRevisions).not.toContain("head-sha");
  });

  it("uses typed safe defaults and still records provenance when a base asset is absent", async () => {
    const resolved = await resolveControlPlane(scope(), {
      reader: new FakeControlPlaneReader({}),
    });

    expect(CONTROL_PLANE_ASSETS.map((asset) => resolved.sourceOf(asset.id))).toEqual(
      CONTROL_PLANE_ASSETS.map(() => "default"),
    );
  });

  it("records head-side policy changes as audit subjects without applying them", async () => {
    const reader = new FakeControlPlaneReader(
      { ".llmorchestratorignore": "base-generated/**\n" },
      [".llmorchestratorignore", ".arbitra/tool-permissions.yaml"],
    );

    const resolved = await resolveControlPlane(scope(), { reader });

    expect(resolved.auditSubjects.map((subject) => subject.assetId)).toEqual([
      "ignore_exclusion_policy",
      "tool_permissions",
    ]);
    expect(resolved.assets.ignore_exclusion_policy.content).toBe("base-generated/**\n");
    expect(resolved.auditSubjects[0]?.note).toMatch(/may become active after entering the trusted base/u);
  });

  it("defeats a head-side ignore-file subversion attempt", async () => {
    const vulnerablePath = "src/auth/vulnerable.ts";
    const reader = new FakeControlPlaneReader(
      { ".llmorchestratorignore": "generated/**\n" },
      [".llmorchestratorignore", vulnerablePath],
    );
    reader.headFiles[".llmorchestratorignore"] = `${vulnerablePath}\n`;

    const resolved = await resolveControlPlane(scope(), { reader });
    const policy = createExclusionPolicy(resolved.assets.ignore_exclusion_policy.content);

    expect(isExcluded(vulnerablePath, policy)).toBe(false);
    expect(resolved.auditSubjects).toContainEqual(expect.objectContaining({
      assetId: "ignore_exclusion_policy",
      disposition: "recorded_not_applied",
    }));
    expect(reader.readRevisions).toEqual(expect.not.arrayContaining(["head-sha"]));
  });

  it("fails closed without an identified trusted base", async () => {
    await expect(resolveControlPlane(
      { repositoryRoot: "repo", trustedBaseRevision: "" },
      { reader: new FakeControlPlaneReader({}) },
    )).rejects.toThrow(/trusted base revision/u);
  });
});

function scope() {
  return {
    repositoryRoot: "repo",
    trustedBaseRevision: "base-sha",
    auditedRevision: "head-sha",
  } as const;
}

class FakeControlPlaneReader implements ControlPlaneReader {
  readonly readRevisions: string[] = [];
  readonly headFiles: Partial<Record<string, string>> = {};

  constructor(
    private readonly baseFiles: Partial<Record<string, string>>,
    private readonly changes: readonly string[] = [],
  ) {}

  async readAtRevision(_root: string, revision: string, path: string): Promise<string | null> {
    this.readRevisions.push(revision);
    if (revision === "head-sha") return this.headFiles[path] ?? null;
    return this.baseFiles[path] ?? null;
  }

  async changedPaths(): Promise<readonly string[]> {
    return this.changes;
  }
}

const _assetIdTypeCheck: ControlPlaneAssetId = "audit_protocol";
void _assetIdTypeCheck;
