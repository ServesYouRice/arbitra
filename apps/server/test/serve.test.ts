import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArbitraAlreadyRunningError, serve } from "../src/server-main.js";

const OLD_BUILD = "0b1a25f (2026-10-22), from a download";

/** A build from before 0.3.1 at the port: it names its build only in the environment route. */
async function olderArbitra(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/diagnostics/environment") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ build: OLD_BUILD, clis: [] })); return; }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("serve at an address another arbitra holds", () => {
  it("names another build instead of opening it, and treats its own build as already running", async () => {
    const { server, port } = await olderArbitra();
    try {
      vi.stubEnv("ARBITRA_PORT", String(port));
      vi.stubEnv("ARBITRA_BUILD", "0.3.1, single-file app");
      const refused = await serve().then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(ArbitraAlreadyRunningError);
      expect(refused).toMatchObject({ build: OLD_BUILD, ours: "0.3.1, single-file app", url: `http://127.0.0.1:${port}` });
      vi.stubEnv("ARBITRA_BUILD", OLD_BUILD);
      await expect(serve()).resolves.toMatchObject({ url: `http://127.0.0.1:${port}`, alreadyRunning: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("starts when nothing answers, and says its build and process at once", async () => {
    const root = await mkdtemp(join(tmpdir(), "arbitra-serve-"));
    vi.stubEnv("ARBITRA_PORT", String(await freePort()));
    vi.stubEnv("ARBITRA_BUILD", "test-build");
    vi.stubEnv("ARBITRA_REPOSITORY", root);
    vi.stubEnv("ARBITRA_WEB_DIST", "");
    for (const cli of ["CLAUDE_CODE", "CODEX", "ANTIGRAVITY", "GEMINI"]) vi.stubEnv(`ARBITRA_${cli}_EXECUTABLE`, join(root, "no-such-cli.exe"));
    const started = await serve();
    try {
      expect(started.alreadyRunning).toBe(false);
      const answer = await (await fetch(`${started.url}/diagnostics/server`, { signal: AbortSignal.timeout(5_000) })).json() as unknown;
      expect(answer).toEqual({ build: "test-build", pid: process.pid });
    } finally {
      await started.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
