import { defineConfig } from "vitest/config";
import { configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("./packages/", import.meta.url)).replaceAll("\\", "/");

export default defineConfig({
  // Test the current workspace sources, not a dependency's last dist/ build.
  // Otherwise cross-package regressions can pass until somebody rebuilds manually.
  resolve: { alias: [
    { find: /^@arbitra\/([^/]+)\/(.+)\.js$/u, replacement: `${packages}$1/src/$2.ts` },
    { find: /^@arbitra\/([^/]+)\/(.+)$/u, replacement: `${packages}$1/src/$2.ts` },
  ] },
  test: {
    // Every workspace package has required suites. A run that discovers none (a broken
    // glob, a moved directory) must fail rather than report success.
    passWithNoTests: false,
    // `pnpm build` emits compiled copies of every suite into dist/. Running those
    // alongside the sources double-runs each test against stale assertions, so a build
    // followed by a test run reports failures that do not exist in the source tree.
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
