import { describe, expect, it } from "vitest";

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
});
