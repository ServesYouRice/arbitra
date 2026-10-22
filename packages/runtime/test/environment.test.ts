import { describe, expect, it } from "vitest";
import type { CliProbe } from "@arbitra/providers/transports/cli/probe.js";
import { ANTIGRAVITY_CAUTION, detectEnvironment } from "../src/environment.js";

const ready = (async () => ({ executable: { found: true, executable: { path: "/bin/cli" } }, versionSupported: true, version: "1.0.0", auth: "logged_in", authDetail: null, usageLimit: null })) as unknown as CliProbe;

describe("the models a machine can run", () => {
  it("carries Google's terms on the Antigravity CLI, whatever its state, and on no other CLI", async () => {
    const environment = await detectEnvironment(() => undefined, ready, async () => null);
    expect(environment.clis.find(({ transport }) => transport === "antigravity-cli")?.caution).toBe(ANTIGRAVITY_CAUTION);
    expect(environment.clis.filter(({ transport }) => transport !== "antigravity-cli").every(({ caution }) => caution === undefined)).toBe(true);
    const missing = await detectEnvironment(() => undefined, (async () => null) as unknown as CliProbe, async () => null);
    expect(missing.clis.find(({ transport }) => transport === "antigravity-cli")).toMatchObject({ state: "not_installed", caution: ANTIGRAVITY_CAUTION });
  });
});
