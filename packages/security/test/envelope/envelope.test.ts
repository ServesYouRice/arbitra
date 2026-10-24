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

  it("grants a test anywhere and a new file beside the module's files, and nothing else", () => {
    const envelope = deriveEnvelope([{ id: "ISSUE-2", accepted: true, locations: [{ path: "server.ts" }] }, ...issues],
      [...modules, { id: "server", files: ["server.ts", "test/server.test.ts"] }]);
    expect(envelope.directories).toEqual([".", "src/auth", "test"]);
    const existing = new Set(["server.ts", "src/auth/login.ts", "src/auth/session.ts", "src/auth/config.json", "test/server.test.ts", "backend/tests/test_api.py",
      "backend/tests/conftest.py", "package.json", ".github/workflows/deploy.yml"]);
    const proposed = ["src/auth/login.test.ts", "test/retry.test.ts", "server.test.ts", "backend/tests/test_api.py", "src/auth/helper.ts",
      "backend/tests/conftest.py", "src/auth/config.json", "src/auth/.npmrc", "vitest.config.ts", "package.json", ".github/workflows/release.yml", ".github/smoke.test.js",
      "scripts/new.ts", "src/auth/new/helper.ts", "src/auth/*.ts"];
    expect(intersectScope(proposed, envelope, { exists: (path) => existing.has(path) })).toEqual({
      granted: ["backend/tests/test_api.py", "server.test.ts", "src/auth/helper.ts", "src/auth/login.test.ts", "test/retry.test.ts"],
      // A setup file, an existing file the modules do not hold, anything in a dot-folder or with a dot-name, a new file
      // at the root, and a new file in a folder the envelope does not hold are not granted.
      displayedOnly: [".github/smoke.test.js", ".github/workflows/release.yml", "backend/tests/conftest.py", "package.json", "scripts/new.ts", "src/auth/*.ts", "src/auth/.npmrc",
        "src/auth/config.json", "src/auth/new/helper.ts", "vitest.config.ts"],
      readFirst: [],
    });
    // Without a way to tell a new file from an existing one, no new file is granted beside the envelope's files.
    expect(intersectScope(["src/auth/helper.ts", "src/auth/login.test.ts"], envelope).granted).toEqual(["src/auth/login.test.ts"]);
    // Exclusions subtract tests and new files too.
    expect(intersectScope({ writeScope: ["src/auth/login.test.ts", "src/auth/helper.ts"], filesNotToTouch: ["src/auth/**"] }, envelope, { exists: () => false }).granted).toEqual([]);
  });
});
