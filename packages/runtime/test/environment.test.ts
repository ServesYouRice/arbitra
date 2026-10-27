import { describe, expect, it } from "vitest";
import type { CliProbe } from "@arbitra/providers/transports/cli/probe.js";
import { ANTIGRAVITY_CAUTION, detectEnvironment } from "../src/environment.js";

const ready = (async () => ({ executable: { found: true, executable: { path: "/bin/cli" } }, versionSupported: true, version: "1.0.0", auth: "logged_in", authDetail: null, usageLimit: null, installations: [] })) as unknown as CliProbe;

describe("the models a machine can run", () => {
  it("carries Google's terms on the Antigravity CLI, whatever its state, and on no other CLI", async () => {
    const environment = await detectEnvironment(() => undefined, ready, async () => null);
    expect(environment.clis.find(({ transport }) => transport === "antigravity-cli")?.caution).toBe(ANTIGRAVITY_CAUTION);
    expect(environment.clis.filter(({ transport }) => transport !== "antigravity-cli").every(({ caution }) => caution === undefined)).toBe(true);
    const missing = await detectEnvironment(() => undefined, (async () => null) as unknown as CliProbe, async () => null);
    expect(missing.clis.find(({ transport }) => transport === "antigravity-cli")).toMatchObject({ state: "not_installed", caution: ANTIGRAVITY_CAUTION });
  });

  it("names the other copies of a CLI it found and does not use", async () => {
    // Observed live (October 26, 2026, macOS): the Codex CLI inside the ChatGPT app was older than the npm one, and
    // nothing showed that two were installed.
    const app = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
    const two = (async () => ({ executable: { found: true, executable: { path: "/opt/homebrew/bin/codex" } }, versionSupported: true, version: "0.164.0", auth: "logged_in", authDetail: null, usageLimit: null,
      installations: [{ path: app, version: "0.158.0" }, { path: "/opt/homebrew/bin/codex", version: "0.164.0" }] })) as unknown as CliProbe;
    const environment = await detectEnvironment(() => undefined, two, async () => null);
    expect(environment.clis.find(({ transport }) => transport === "codex-cli")).toMatchObject({ path: "/opt/homebrew/bin/codex", version: "0.164.0", state: "ready", others: [{ path: app, version: "0.158.0" }] });
    expect((await detectEnvironment(() => undefined, ready, async () => null)).clis.every((cli) => !("others" in cli))).toBe(true);
  });
});
