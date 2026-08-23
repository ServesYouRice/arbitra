import { describe, expect, it } from "vitest";

import { createExclusionPolicy, isExcluded } from "../src/exclusions.js";

describe("repository exclusions", () => {
  it.each([
    "implementation/manifest.json",
    "implementation/tasks/TASK-001/task.md",
    ".runs/run-1/private/continuation-state/state.json",
  ])("unconditionally excludes %s", (path) => {
    const attemptedNegation = createExclusionPolicy("!implementation/**\n!.runs/**");
    expect(isExcluded(path, attemptedNegation)).toBe(true);
  });

  it("applies vendor, build, and project ignore rules", () => {
    const policy = createExclusionPolicy("generated/**\n*.secret\n# comment");
    expect(isExcluded("packages/a/node_modules/x.js", policy)).toBe(true);
    expect(isExcluded("packages/a/dist/x.js", policy)).toBe(true);
    expect(isExcluded("generated/client.ts", policy)).toBe(true);
    expect(isExcluded("config/local.secret", policy)).toBe(true);
    expect(isExcluded("src/index.ts", policy)).toBe(false);
  });

  it("fails closed for paths outside the repository", () => {
    expect(isExcluded("../credential.txt")).toBe(true);
    expect(isExcluded("C:\\outside\\credential.txt")).toBe(true);
  });
});
