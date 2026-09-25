import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.js";

// The native-adapter suites spawn stand-in processes and wait for their whole process
// group to be reaped (up to 5 s). On a macOS CI runner under full-suite contention the
// timeout case alone exceeded the 5 s default, so the limit leaves room for that wait.
export default mergeConfig(root, defineConfig({
  test: { testTimeout: 20_000 },
}));
