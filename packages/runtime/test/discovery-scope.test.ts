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

  it("packs each Dart test with the source it tests, through the app's own package imports", () => {
    // Observed on veritra (October 25, 2026): 57 Flutter tests import `package:private_messenger/…`, which nothing
    // resolved, so they filled units of their own. `lib/services.dart` shares a path with a Flutter library, and the
    // generated localizations were left out of the scope.
    const files = [
      file("mobile/lib/core/app_state.dart", "import 'api_client.dart';\nclass AppState {}"), file("mobile/lib/core/api_client.dart", "class ApiClient {}"),
      file("mobile/lib/services.dart", "class Services {}"), file("mobile/lib/sync/sync_service.dart", "class SyncService {}"),
      file("mobile/test/app_state_test.dart", ["import 'package:flutter/services.dart';", "import 'package:flutter/widgets.dart';", "import 'package:flutter_test/flutter_test.dart';",
        "import 'package:private_messenger/core/api_client.dart';", "import 'package:private_messenger/core/app_state.dart';", "import 'support/fakes.dart';"].join("\n")),
      file("mobile/test/support/fakes.dart", "import 'package:private_messenger/core/api_client.dart';\nimport 'package:private_messenger/l10n/app_localizations.dart';"),
      file("mobile/integration_test/sync_service_test.dart", "import \"package:private_messenger/sync/sync_service.dart\";"),
    ];
    const result = allocateDiscoveryScopes({ root: "fixture", files }, (selected) => selected.length <= 2);
    const units = result.scopes.map(({ files: selected }) => selected.map(({ path }) => path).sort().join());
    expect(units).toContain("mobile/lib/core/app_state.dart,mobile/test/app_state_test.dart");
    expect(units).toContain("mobile/integration_test/sync_service_test.dart,mobile/lib/sync/sync_service.dart");
    expect(units).toContain("mobile/lib/core/api_client.dart,mobile/test/support/fakes.dart");
    expect(units).toContain("mobile/lib/services.dart");
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
