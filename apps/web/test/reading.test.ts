import { describe, expect, it } from "vitest";
import type { ReadFile } from "../src/api/runs.js";
import { covers, folderGroups, groupRead, reading, testCover, testsRead, withGroup, withPath, withTests } from "../src/pages/new-run/reading.js";

const file = (path: string, lines: number, test = false): ReadFile => ({ path, lines, test, leftOut: false });
// veritra's shape (October 25, 2026): four folders, tests beside the code and in their own folder, generated Dart.
const VERITRA: readonly ReadFile[] = [
  file("server/main.go", 30_000), file("server/main_test.go", 9_209, true),
  file("mobile/lib/app.dart", 40_000), file("mobile/lib/db.g.dart", 7_226), file("mobile/test/app_test.dart", 5_445, true),
  file("scripts/build.sh", 7_541), file("crypto/box.rs", 3_738), file("Makefile.ps1", 12),
];

describe("what a run reads", () => {
  it("counts a leave-out as the snapshot does: the path itself or a folder above it, whatever its slashes", () => {
    expect([covers("server", "server/main.go"), covers("server/", "server/main.go"), covers("./server", "server/main.go"), covers("serv", "server/main.go"), covers("mobile\\lib", "mobile/lib/app.dart")])
      .toEqual([true, true, true, false, true]);
    expect(reading(VERITRA, [])).toEqual({ files: 8, lines: 103_171, testFiles: 2, testLines: 14_654 });
    expect(reading(VERITRA, ["mobile/lib/db.g.dart", "scripts"])).toEqual({ files: 6, lines: 88_404, testFiles: 2, testLines: 14_654 });
  });

  it("groups the files by folder, the files at the top on their own, and opens a folder that holds most of the project", () => {
    expect(folderGroups(VERITRA).map(({ label, leaveOut }) => [label, leaveOut])).toEqual([
      ["mobile", ["mobile"]], ["server", ["server"]], ["scripts", ["scripts"]], ["crypto", ["crypto"]], ["files at the top", ["Makefile.ps1"]]]);
    // One folder with nearly everything says nothing; its own folders say where the lines are.
    const app = [file("src/server/a.ts", 6_000), file("src/client/b.ts", 3_000), file("src/index.ts", 200), file("test/a.test.ts", 500, true)];
    expect(folderGroups(app).map(({ label, leaveOut, files }) => [label, leaveOut, files.length])).toEqual([
      ["src/server", ["src/server"], 1], ["src/client", ["src/client"], 1], ["test", ["test"], 1], ["src · files in it", ["src/index.ts"], 1]]);
  });

  it("leaves a folder out with one tick and reads it again with the next, keeping the other leave-outs", () => {
    const groups = folderGroups(VERITRA);
    const mobile = groups.find(({ label }) => label === "mobile");
    if (mobile === undefined) throw new Error("no mobile group");
    const out = withGroup(["mobile/lib/db.g.dart"], groups, mobile, false);
    expect(out).toEqual(["mobile/lib/db.g.dart", "mobile"]);
    expect(groupRead(mobile, out)).toBe(false);
    expect(withGroup(out, groups, mobile, true)).toEqual(["mobile/lib/db.g.dart"]);
    // A folder left out by a typed path above it is read again without reading its neighbours.
    const app = [file("src/server/a.ts", 6_000), file("src/client/b.ts", 3_000), file("src/index.ts", 200)];
    const appGroups = folderGroups(app);
    const server = appGroups.find(({ label }) => label === "src/server");
    if (server === undefined) throw new Error("no server group");
    expect(withGroup(["src"], appGroups, server, true)).toEqual(["src/client", "src/index.ts"]);
  });

  it("leaves the tests out by their folders where a folder holds only tests, else file by file, and reads them again", () => {
    expect(testCover(VERITRA)).toEqual(["mobile/test", "server/main_test.go"]);
    expect(testsRead(VERITRA, [])).toBe(true);
    const out = withTests(["scripts"], VERITRA, false);
    expect(out).toEqual(["scripts", "mobile/test", "server/main_test.go"]);
    expect([testsRead(VERITRA, out), reading(VERITRA, out).testLines]).toEqual([false, 0]);
    expect(withTests(out, VERITRA, true)).toEqual(["scripts"]);
  });

  it("reads one suggested file anyway, or leaves it out again", () => {
    expect(withPath(["scripts"], "mobile/lib/db.g.dart", true)).toEqual(["scripts", "mobile/lib/db.g.dart"]);
    expect(withPath(["scripts", "mobile/lib/db.g.dart"], "mobile/lib/db.g.dart", false)).toEqual(["scripts"]);
    expect(withPath(["scripts", "mobile/lib/db.g.dart"], "mobile/lib/db.g.dart", true)).toEqual(["scripts", "mobile/lib/db.g.dart"]);
  });
});
