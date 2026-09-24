import { afterEach, expect, it, vi } from "vitest";
import { RunApi } from "../src/api/runs.js";

afterEach(() => { vi.unstubAllGlobals(); });

// Found by browser QA: Fastify rejects an empty body declared as JSON with 400, so resume
// and cancel failed in every browser while mocked unit tests passed.
it("sends bodiless lifecycle POSTs without a JSON content type and JSON bodies with one", async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => { requests.push({ url, init }); return new Response(JSON.stringify({ runId: "run-1", state: "RUNNING", resumable: true, checkpoints: [] }), { status: 200 }); });
  const api = new RunApi();
  await api.resume("run-1"); await api.cancel("run-1"); await api.respondCheckpoint("run-1", "approval", "a".repeat(64), "approve");
  expect(requests.map(({ url, init }) => [url, init?.method, (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? null, init?.body ?? null])).toEqual([
    ["/runs/run-1/resume", "POST", null, null],
    ["/runs/run-1/cancel", "POST", null, null],
    ["/runs/run-1/checkpoints/approval", "POST", "application/json", JSON.stringify({ version: "a".repeat(64), decision: "approve" })],
  ]);
});
