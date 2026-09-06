import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSnapshot, detectWorkingTreeDrift, type GitRunner } from "../src/snapshot.js";

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

describe("repository snapshot", () => {
  it("captures immutable full-scope identity and working tree state", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "new.ts"), "export const value = 1;\n");
    const git = new FakeGit(root, {
      "branch --show-current": "main\n",
      "rev-parse HEAD": "abc123\n",
      "status --porcelain=v1 -z --untracked-files=all": " M src/a.ts\0?? src/new.ts\0",
      "ls-files --stage -z": "100644 abc 0\tsrc/a.ts\0",
      "diff --binary --no-ext-diff HEAD --": "diff-content",
    });

    const snapshot = await createSnapshot(root, { kind: "full" }, { git });

    expect(snapshot).toMatchObject({ branch: "main", commit: "abc123", dirty: true });
    expect(snapshot.changedFiles).toEqual(["src/a.ts", "src/new.ts"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.changedFiles)).toBe(true);
  });

  it("captures base, head, merge-base, and changed files for a diff", async () => {
    const root = await temporaryDirectory();
    const git = new FakeGit(root, {
      "branch --show-current": "feature\n",
      "rev-parse HEAD": "head-sha\n",
      "status --porcelain=v1 -z --untracked-files=all": "",
      "ls-files --stage -z": "100644 abc 0\tsrc/a.ts\0",
      "diff --binary --no-ext-diff HEAD --": "",
      "diff --name-only -z base head": "src/b.ts\0src/a.ts\0",
      "merge-base base head": "merge-sha\n",
    });

    const snapshot = await createSnapshot(root, { kind: "diff", base: "base", head: "head" }, { git });

    expect(snapshot.scope).toEqual({ kind: "diff", base: "base", head: "head", mergeBase: "merge-sha" });
    expect(snapshot.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("warns when tracked state changes after capture", async () => {
    const root = await temporaryDirectory();
    const git = new FakeGit(root, {
      "branch --show-current": "main\n",
      "rev-parse HEAD": "abc123\n",
      "status --porcelain=v1 -z --untracked-files=all": "",
      "ls-files --stage -z": "100644 abc 0\tsrc/a.ts\0",
      "diff --binary --no-ext-diff HEAD --": "",
    });
    const snapshot = await createSnapshot(root, { kind: "full" }, { git });
    git.responses["status --porcelain=v1 -z --untracked-files=all"] = " M src/a.ts\0";
    git.responses["diff --binary --no-ext-diff HEAD --"] = "changed bytes";

    await expect(detectWorkingTreeDrift(snapshot, git)).resolves.toMatchObject({
      changed: true,
      warning: expect.stringMatching(/changed materially/u),
    });
  });

  it("records both sides of a working-tree rename", async () => {
    const root = await temporaryDirectory();
    const git = new FakeGit(root, {
      "branch --show-current": "main\n",
      "rev-parse HEAD": "abc123\n",
      "status --porcelain=v1 -z --untracked-files=all": "R  src/new.ts\0src/old.ts\0",
      "ls-files --stage -z": "100644 abc 0\tsrc/new.ts\0",
      "diff --binary --no-ext-diff HEAD --": "rename",
    });

    const snapshot = await createSnapshot(root, { kind: "full" }, { git });
    expect(snapshot.changedFiles).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("detects content changes even when porcelain status is unchanged", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "new.ts"), "first\n");
    const git = new FakeGit(root, {
      "branch --show-current": "main\n", "rev-parse HEAD": "abc123\n",
      "status --porcelain=v1 -z --untracked-files=all": "?? new.ts\0",
      "ls-files --stage -z": "", "diff --binary --no-ext-diff HEAD --": "",
    });
    const snapshot = await createSnapshot(root, { kind: "full" }, { git });
    await writeFile(join(root, "new.ts"), "second\n");
    await expect(detectWorkingTreeDrift(snapshot, git)).resolves.toMatchObject({ changed: true });
  });
});

class FakeGit implements GitRunner {
  constructor(
    private readonly root: string,
    readonly responses: Record<string, string>,
  ) {}

  async run(_root: string, args: readonly string[]): Promise<string> {
    if (args.join(" ") === "rev-parse --show-toplevel") return this.root;
    const result = this.responses[args.join(" ")];
    if (result === undefined) throw new Error(`Unexpected git call: ${args.join(" ")}`);
    return result;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arbitra-snapshot-"));
  temporaryDirectories.push(directory);
  return directory;
}
