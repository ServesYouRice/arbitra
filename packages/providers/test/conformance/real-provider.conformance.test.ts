import { readFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BATCH_DRIVER_DECLARATIONS } from "../../src/batch/drivers.js";

/**
 * Gate over recorded live evidence. It no longer trusts supplied booleans: it reads the
 * provenance-bearing observations written by live-transport.conformance.test.ts (and the
 * batch runner) and requires, per capability, at least one `passed` live observation that
 * names its endpoint, protocol and model and carries measured usage or a provider request ID.
 *
 *   ARBITRA_REAL_PROVIDER_CONFORMANCE=1 ARBITRA_LIVE_EVIDENCE=.runs/live/transport-conformance.json:.runs/live/batch-conformance.json
 */
const enabled = process.env["ARBITRA_REAL_PROVIDER_CONFORMANCE"] === "1";

interface Observation {
  readonly endpointId: string; readonly transport: string; readonly modelId: string; readonly case: string; readonly status: string; readonly source: string;
  readonly providerRequestIds: readonly string[]; readonly usage: readonly { inputTokens: number | null }[];
}
/** ARBITRA_LIVE_EVIDENCE may list several files (path-delimiter separated), e.g. transport and batch evidence. */
async function evidence(): Promise<readonly Observation[]> {
  const paths = (process.env["ARBITRA_LIVE_EVIDENCE"] ?? "").split(delimiter).filter((path) => path !== "");
  expect(paths.length, "Set ARBITRA_LIVE_EVIDENCE to the evidence file(s) written by the live conformance runners").toBeGreaterThan(0);
  const reports = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8")) as { observations?: Observation[] }));
  return reports.flatMap((report) => report.observations ?? []);
}
const provenanced = (observation: Observation) => observation.source === "live" && observation.endpointId !== "" && observation.transport !== "" && observation.modelId !== ""
  && (observation.providerRequestIds.length > 0 || observation.usage.some(({ inputTokens }) => (inputTokens ?? 0) > 0));

describe.skipIf(!enabled)("real-provider declared-capability conformance", () => {
  it.each(["text", "structured_output", "tools", "output_limit", "cancellation", "timeout_retry", "cache_accounting", "continuation"])(
    "has a passed live observation with provenance for %s",
    async (capability) => {
      const passed = (await evidence()).filter((observation) => observation.case === capability && observation.status === "passed");
      expect(passed.length, `No live observation passed ${capability}`).toBeGreaterThan(0);
      // Cancellation and timeout end before a response exists, so they cannot carry usage.
      if (!["cancellation", "timeout_retry"].includes(capability)) expect(passed.some(provenanced), `${capability} lacks provider request identity or measured usage`).toBe(true);
    },
  );

  // Every declared batch driver needs its own live submit/poll/results evidence.
  it.each(BATCH_DRIVER_DECLARATIONS.map(({ driverId }) => driverId))(
    "requires live batch validation for driver %s",
    async (driverId) => {
      const passed = (await evidence()).filter((observation) => observation.case === `batch:${driverId}` && observation.status === "passed" && provenanced(observation));
      expect(passed.length, `No live observation validated batch driver ${driverId}`).toBeGreaterThan(0);
    },
  );
});
