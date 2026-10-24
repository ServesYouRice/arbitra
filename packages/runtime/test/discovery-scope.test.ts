import { describe, expect, it } from "vitest";
import { allocateDiscoveryScopes, modulePartition } from "../src/discovery-scope.js";

const file = (path: string, content = "export const value = 1;") => ({ path, lines: content.split("\n"), byteLength: Buffer.byteLength(content), lineStartBytes: [0] });

describe("discovery scope allocation", () => {
  it("keeps cross-directory import chains together instead of partitioning by directory", () => {
    const files = [file("ui/a.ts", "import { value } from '../data/b.js';"), file("data/b.ts"), file("other/c.ts")];
    const result = allocateDiscoveryScopes({ root: "fixture", files }, (selected) => selected.length <= 2);
    expect(result.scopes.some(({ files }) => files.map(({ path }) => path).sort().join() === "data/b.ts,ui/a.ts")).toBe(true);
    expect(result.scopes.flatMap(({ splitModules }) => splitModules)).toEqual([]);
    expect(result.unallocatedPaths).toEqual([]);
  });

  it("reports split modules and oversized files without dropping unsupported source extensions", () => {
    const files = [file("ui/a.ts", "import '../data/b.js';"), file("data/b.ts"), file("theme.css"), file("huge.ts", "x".repeat(200))];
    const result = allocateDiscoveryScopes({ root: "fixture", files }, (selected) => selected.length <= 1 && selected.every(({ byteLength }) => byteLength < 100));
    expect(result.scopes.flatMap(({ files }) => files.map(({ path }) => path)).sort()).toEqual(["data/b.ts", "theme.css", "ui/a.ts"]);
    expect(result.scopes.flatMap(({ splitModules }) => splitModules)).toHaveLength(2);
    expect(result.unallocatedPaths).toEqual(["huge.ts"]);
  });

  it("packs each test file with the source it tests, in JavaScript and in Python", () => {
    // Observed live: path order put every test after all the source, in units of their own.
    const files = [
      file("lib/a.js", "module.exports = 1;"), file("lib/b.js", "module.exports = 2;"), file("lib/c.js", "module.exports = 3;"),
      file("tests/a.test.js", "const a = require('../lib/a.js');\nconst c = require('../lib/c.js');"), file("tests/c.test.js", "require('../lib/c.js');"),
      file("backend/app/backup.py", "def restore(): pass"), file("backend/app/db.py", "def connect(): pass"), file("backend/app/__init__.py", ""),
      file("backend/tests/test_backup.py", "from app.backup import restore\nfrom app import db\n"), file("backend/tests/test_db.py", "import app.db as db\n"),
      file("backend/app/jobs/run.py", "from ..db import connect\nfrom . import queue\n"), file("backend/app/jobs/queue.py", ""),
    ];
    const result = allocateDiscoveryScopes({ root: "fixture", files }, (selected) => selected.length <= 2);
    const units = result.scopes.map(({ files: selected }) => selected.map(({ path }) => path).sort().join());
    // a.test.js imports a.js and c.js, and goes with the one its name carries.
    expect(units).toContain("lib/a.js,tests/a.test.js");
    expect(units).toContain("lib/c.js,tests/c.test.js");
    expect(units).toContain("backend/app/backup.py,backend/tests/test_backup.py");
    expect(units).toContain("backend/app/db.py,backend/tests/test_db.py");
    expect(result.scopes.flatMap(({ files: selected }) => selected.map(({ path }) => path)).sort()).toEqual(files.map(({ path }) => path).sort());
  });

  it("partitions the files into the modules discovery packs, each test in the module of the source it tests", () => {
    const files = [file("lib/a.js", "module.exports = 1;"), file("tests/a.test.js", "require('../lib/a.js');"), file("theme.css"),
      file("backend/app/backup.py", "def restore(): pass"), file("backend/tests/test_backup.py", "from app.backup import restore\n")];
    expect(modulePartition({ root: "fixture", files })).toEqual([
      { id: "backend/app/backup", files: ["backend/app/backup.py", "backend/tests/test_backup.py"] },
      { id: "lib", files: ["lib/a.js", "tests/a.test.js"] },
      { id: "theme.css", files: ["theme.css"] },
    ]);
  });
});
