import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { plannerCommandContext, projectCommands } from "../src/project-commands.js";
import type { RepositorySnapshot } from "../src/repository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository(files: Readonly<Record<string, string>>, sources: readonly string[]): Promise<RepositorySnapshot> {
  const root = await mkdtemp(join(tmpdir(), "arbitra-project-commands-")); roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, files: sources.map((path) => ({ path, lines: [] })) } as unknown as RepositorySnapshot;
}

it("lists the test, typecheck, lint, check and build commands the manifests declare, root first", async () => {
  const snapshot = await repository({
    "package.json": JSON.stringify({ packageManager: "pnpm@10.24.0", scripts: { test: "vitest run", "test:e2e": "playwright test", typecheck: "tsc -b", lint: "eslint .", dev: "vite", build: "vite build" } }),
    "apps/web/package.json": JSON.stringify({ scripts: { test: "vitest run", start: "vite" } }),
    "Makefile": "VERSION := 1\ntest: build\n\tgo test ./...\nclean:\n\trm -rf out\n",
    "services/api/go.mod": "module example.test/api\n",
    "crates/core/Cargo.toml": "[package]\nname = \"core\"\n",
    "tools/pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-q\"\n[tool.ruff]\nline-length = 100\n",
    "broken/package.json": "{ not json",
  }, ["apps/web/src/main.ts", "services/api/main.go", "crates/core/src/lib.rs", "tools/check.py", "broken/index.js"]);
  const commands = await projectCommands(snapshot);
  expect(commands.map(({ purpose, command, directory }) => [purpose, command, directory])).toEqual([
    ["test", "pnpm run test", ""], ["test", "pnpm run test:e2e", ""], ["test", "make test", ""], ["typecheck", "pnpm run typecheck", ""], ["lint", "pnpm run lint", ""], ["build", "pnpm run build", ""],
    ["test", "python -m pytest", "tools"], ["lint", "ruff check .", "tools"],
    ["test", "pnpm --dir apps/web run test", ""],
    ["test", "cargo test --manifest-path crates/core/Cargo.toml", ""], ["lint", "cargo clippy --manifest-path crates/core/Cargo.toml", ""], ["build", "cargo build --manifest-path crates/core/Cargo.toml", ""],
    ["test", "go test ./...", "services/api"], ["lint", "go vet ./...", "services/api"], ["build", "go build ./...", "services/api"],
  ]);
  expect(commands[0]).toMatchObject({ sourcePath: "package.json", source: "vitest run" });
  // A plan stage reads what the commands are for; a project that declares none adds nothing to its input.
  expect(plannerCommandContext(commands)?.commands[0]).toEqual({ purpose: "test", command: "pnpm run test", from: "package.json" });
  expect(plannerCommandContext(commands)?.commands.find(({ command }) => command === "go test ./...")).toEqual({ purpose: "test", command: "go test ./...", directory: "services/api", from: "services/api/go.mod" });
  expect(plannerCommandContext([])).toBeUndefined();
});

it("runs a workspace's scripts with the manager its lockfile names, and a package's own when it names one", async () => {
  const snapshot = await repository({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "",
    "packages/a/package.json": JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest" } }),
  }, ["packages/a/index.ts"]);
  expect((await projectCommands(snapshot)).map(({ command }) => command)).toEqual(["yarn run test", "pnpm --dir packages/a run test"]);
});
