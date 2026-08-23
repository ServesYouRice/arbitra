import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryPathGuard, resolveInsideRoot } from "../src/path-guard.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const relativeToTemp = relative(resolve(tmpdir()), resolve(directory));
    if (relativeToTemp.startsWith("..") || isAbsolute(relativeToTemp)) {
      throw new Error(`Refusing to remove non-temporary path: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

describe("repository path guard", () => {
  it("rejects lexical traversal", () => {
    expect(() => resolveInsideRoot("repo", "../outside.txt")).toThrow(/outside/u);
    expect(() => resolveInsideRoot("repo", "nested/../../outside.txt")).toThrow(/outside/u);
  });

  it("reads a file inside the validated root", async () => {
    const root = await temporaryDirectory("arbitra-root-");
    await writeFile(join(root, "inside.txt"), "safe", "utf8");
    const guard = await RepositoryPathGuard.create(root);
    await expect(guard.readFile("inside.txt")).resolves.toBe("safe");
  });

  it("rejects a symlink that resolves outside the root", async () => {
    const root = await temporaryDirectory("arbitra-root-");
    const outside = await temporaryDirectory("arbitra-outside-");
    await writeFile(join(outside, "secret.txt"), "credential", "utf8");
    await symlink(outside, join(root, "links"), "junction");
    const guard = await RepositoryPathGuard.create(root);
    await expect(guard.readFile("links/secret.txt")).rejects.toThrow(/outside/u);
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
