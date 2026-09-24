import { describe, expect, it } from "vitest";
import { BATCH_DRIVER_DECLARATIONS } from "../../src/batch/drivers.js";

const enabled = process.env["ARBITRA_REAL_PROVIDER_CONFORMANCE"] === "1";

describe.skipIf(!enabled)("real-provider declared-capability conformance", () => {
  it.each(["structuredOutput", "parallelToolCalls", "promptCaching", "continuation"])(
    "requires an external signed report for %s",
    (capability) => {
      const raw = process.env["ARBITRA_CONFORMANCE_REPORT"];
      expect(raw, "Set ARBITRA_CONFORMANCE_REPORT to the JSON output of the opt-in real-provider runner").toBeTruthy();
      const report = JSON.parse(raw ?? "{}") as Record<string, boolean>;
      expect(report[capability], `Real-provider report did not verify ${capability}`).toBe(true);
    },
  );

  // Every declared batch driver needs its own live submit/poll/results/cancel evidence.
  it.each(BATCH_DRIVER_DECLARATIONS.map(({ driverId }) => driverId))(
    "requires live batch validation for driver %s",
    (driverId) => {
      const report = JSON.parse(process.env["ARBITRA_CONFORMANCE_REPORT"] ?? "{}") as Record<string, boolean>;
      expect(report[`batch:${driverId}`], `Real-provider report did not verify batch driver ${driverId}`).toBe(true);
    },
  );
});
