import { defineConfig, devices } from "@playwright/test";

/**
 * Browser acceptance for the operator interface (completion plan P10).
 *
 * `pnpm --filter @arbitra/web e2e` builds the server fixture and the web app, then starts
 * the real control plane over a temporary state directory (apps/server/fixtures/e2e-server.ts)
 * with runs produced by the real orchestrator and scripted provider/sandbox ports.
 * Kept out of `pnpm test` because it needs installed browser builds.
 */
const port = Number(process.env["E2E_PORT"] ?? 4179);
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1600, height: 1000 }, trace: "retain-on-failure", acceptDownloads: true },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: "node ../server/dist/fixtures/e2e-server.js",
    env: { E2E_PORT: String(port), E2E_WEB_DIST: "dist" },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
});
