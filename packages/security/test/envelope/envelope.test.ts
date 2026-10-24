import { describe, expect, it } from "vitest";

import { deriveEnvelope, intersectScope } from "../../src/envelope.js";

const modules = [
  { id: "auth", files: ["src/auth/login.ts", "src/auth/session.ts"] },
  { id: "deploy", files: [".github/workflows/deploy.yml"] },
] as const;
const issues = [
  { id: "ISSUE-1", accepted: true, locations: [{ path: "src/auth/login.ts" }] },
  { id: "ISSUE-REJECTED", accepted: false, locations: [{ moduleId: "deploy" }] },
] as const;

describe("orchestrator-derived write envelope", () => {
  it("derives module authority from accepted issue locations, never proposed scope", () => {
    const envelope = deriveEnvelope(issues, modules);
    expect(envelope).toMatchObject({
      paths: ["src/auth/login.ts", "src/auth/session.ts"],
      sourceIssueIds: ["ISSUE-1"],
      sourceModuleIds: ["auth"],
    });
    expect(intersectScope(["src/auth/login.ts", ".github/workflows/deploy.yml"], envelope)).toEqual({
      granted: ["src/auth/login.ts"],
      displayedOnly: [".github/workflows/deploy.yml"],
      readFirst: [],
    });
  });

  it("lets exclusions only subtract and bounds readFirst by the reduced envelope", () => {
    const envelope = deriveEnvelope(issues, modules);
    expect(intersectScope({
      writeScope: ["src/auth/**", ".github/workflows/deploy.yml"],
      filesNotToTouch: ["src/auth/session.ts", ".github/workflows/deploy.yml"],
      readFirst: ["src/auth/login.ts", "README.md"],
    }, envelope)).toEqual({
      granted: ["src/auth/login.ts"],
      displayedOnly: [".github/workflows/deploy.yml", "README.md"],
      readFirst: ["src/auth/login.ts"],
    });
  });

  it("does not gain sensitive scope through planner omission", () => {
    const envelope = deriveEnvelope(issues, modules);
    const result = intersectScope({ writeScope: ["src/auth/**"], filesNotToTouch: [] }, envelope);
    expect(result.granted).not.toContain(".github/workflows/deploy.yml");
    expect(envelope.paths).not.toContain(".github/workflows/deploy.yml");
  });
});
