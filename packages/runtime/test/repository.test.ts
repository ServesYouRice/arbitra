import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { snapshotRepository, type RepositoryGit } from "../src/repository.js";

describe("runtime repository snapshots", () => {
  it("reads the correct version from a real Git index, worktree and revision range", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-git-scopes-"));
    const execute = promisify(execFile);
    const git = async (...args: string[]) => (await execute("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim();
    try {
      await git("init");
      await writeFile(join(root, "source.ts"), "original\n");
      await git("add", "source.ts");
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "original");
      const base = await git("rev-parse", "HEAD");
      await writeFile(join(root, "source.ts"), "committed\n");
      await git("add", "source.ts");
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "updated");
      await writeFile(join(root, "source.ts"), "staged\n");
      await git("add", "source.ts");
      await writeFile(join(root, "source.ts"), "working\n");
      const scopes = [
        { kind: "diff" as const, diffMode: "staged" as const },
        { kind: "diff" as const, diffMode: "working_tree" as const },
        { kind: "diff" as const, base, head: "HEAD" },
        { kind: "diff" as const, revisionRange: `${base}...HEAD` },
      ];
      const snapshots = await Promise.all(scopes.map((scope) => snapshotRepository(root, 5, { scope })));
      expect(snapshots.map(({ files }) => files[0]?.lines[0])).toEqual(["staged", "working", "committed", "committed"]);
      expect(await git("diff", "--name-only")).toBe("source.ts");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("restricts module scope and reads staged contents instead of unstaged edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-snapshot-scoped-"));
    try {
      await mkdir(join(root, "selected"));
      await writeFile(join(root, "selected", "a.ts"), "unstaged bytes\n");
      await writeFile(join(root, "unrelated.ts"), "unrelated bytes\n");
      const moduleSnapshot = await snapshotRepository(root, 1, { scope: { kind: "module", modules: ["selected"] } });
      expect(moduleSnapshot.files.map(({ path }) => path)).toEqual(["selected/a.ts"]);
      const calls: string[][] = [];
      const git: RepositoryGit = { async run(_root, args) { calls.push([...args]); if (args[0] === "diff") return "selected/a.ts\0"; if (args[0] === "show" && args[1] === ":selected/a.ts") return "staged bytes\n"; throw new Error("unexpected git command"); } };
      const staged = await snapshotRepository(root, 1, { scope: { kind: "diff", diffMode: "staged" }, git });
      expect(staged.files[0]?.lines[0]).toBe("staged bytes");
      expect(calls[0]).toContain("--cached");
      await expect(snapshotRepository(root, 1, { scope: { kind: "diff", base: "--output=unsafe", head: "HEAD" }, git })).rejects.toThrow("INVALID_DIFF_REVISION");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("never follows a source-file symlink outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-snapshot-root-"));
    const outside = await mkdtemp(join(tmpdir(), "arbitra-snapshot-outside-"));
    try {
      await writeFile(join(root, "inside.ts"), "export const inside = true;\n", "utf8");
      await writeFile(join(outside, "secret.ts"), "export const secret = 'outside';\n", "utf8");
      // A junction is available without Windows developer-mode privileges. Giving it a
      // source-looking name also proves the walker checks the entry type before extension.
      await symlink(outside, join(root, "linked.ts"), "junction");

      const snapshot = await snapshotRepository(root);

      expect(snapshot.files.map(({ path }) => path)).toEqual(["inside.ts"]);
      expect(JSON.stringify(snapshot)).not.toContain("outside");
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it("fails closed rather than silently truncating repository coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-snapshot-limit-"));
    try {
      await Promise.all([writeFile(join(root, "a.ts"), "export {};\n"), writeFile(join(root, "b.ts"), "export {};\n")]);
      await expect(snapshotRepository(root, 1)).rejects.toThrow("REPOSITORY_FILE_LIMIT_EXCEEDED:1");
      await expect(snapshotRepository(root, 0)).rejects.toThrow("INVALID_MAXIMUM_FILES");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
