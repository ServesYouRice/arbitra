import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.js";

// The runtime suites drive whole durable workflows (journals, worktrees, restarts) through
// the public orchestrator. Measured on an M-series laptop with the full suite in parallel,
// the slowest cases (oversized planner revision, Feature planning replays) take 4–25 s and
// roughly double under full-suite contention, so the 5 s default timed out 24 of 311 tests
// on every run. Limits sit above the slowest measured case with headroom for CI runners.
export default mergeConfig(root, defineConfig({
  test: { testTimeout: 90_000, hookTimeout: 30_000 },
}));
