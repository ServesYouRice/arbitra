import { defineConfig } from "vitest/config";
import { configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // `pnpm build` emits compiled copies of every suite into dist/. Running those
    // alongside the sources double-runs each test against stale assertions, so a build
    // followed by a test run reports failures that do not exist in the source tree.
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
