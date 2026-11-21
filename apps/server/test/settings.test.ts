import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { controlPlaneCore } from "@arbitra/runtime/control-plane-core.js";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { settingsFile } from "@arbitra/runtime/run-helper.js";
import { buildServer } from "../src/main.js";
import { registerSettingsRoutes } from "../src/settings.js";

describe("the settings routes", () => {
  it("reads the run helper's settings with their defaults, saves a change the helper reads at once, and keeps the rest of the file", async () => {
    const state = await mkdtemp(join(tmpdir(), "arbitra-settings-"));
    const app = buildServer(controlPlaneCore(new Orchestrator({ repository: state, stateDirectory: state })));
    registerSettingsRoutes(app, state);
    try {
      // No settings file: the helper is on, on a frontier model.
      expect((await app.inject({ method: "GET", url: "/settings" })).json()).toEqual({ helper: { autoResume: true, model: { transport: "claude-code-cli", modelId: "claude-opus-5-5" } } });
      await writeFile(join(state, "settings.json"), JSON.stringify({ other: { kept: true }, helper: { note: "a person's own" } }));
      const saved = await app.inject({ method: "PUT", url: "/settings", payload: { helper: { autoResume: false, model: { transport: "codex-cli", modelId: "gpt-6.1-sol" } } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ helper: { autoResume: false, model: { transport: "codex-cli", modelId: "gpt-6.1-sol" } } });
      expect(JSON.parse(await readFile(join(state, "settings.json"), "utf8"))).toEqual({ other: { kept: true }, helper: { note: "a person's own", autoResume: false, model: { transport: "codex-cli", modelId: "gpt-6.1-sol" } } });
      expect(await settingsFile(state).autoResume()).toBe(false);
      // One setting at a time leaves the other as it was.
      expect((await app.inject({ method: "PUT", url: "/settings", payload: { helper: { autoResume: true } } })).json()).toEqual({ helper: { autoResume: true, model: { transport: "codex-cli", modelId: "gpt-6.1-sol" } } });
      expect((await app.inject({ method: "GET", url: "/settings" })).json()).toMatchObject({ helper: { autoResume: true, model: { modelId: "gpt-6.1-sol" } } });
    } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
  });

  it("refuses a change of another shape, and does not overwrite a settings file that is not JSON", async () => {
    const state = await mkdtemp(join(tmpdir(), "arbitra-settings-"));
    const app = buildServer(controlPlaneCore(new Orchestrator({ repository: state, stateDirectory: state })));
    registerSettingsRoutes(app, state);
    try {
      for (const payload of [{ helper: { autoResume: "no" } }, { helper: { model: { transport: "openai-chat", modelId: "kimi" } } }, { helper: { model: { transport: "codex-cli", modelId: "" } } }, { helper: { colour: "red" } }, { autoResume: false }]) {
        const refused = await app.inject({ method: "PUT", url: "/settings", payload });
        expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
        expect(refused.json<{ message: string }>().message).toMatch(/^SETTINGS_INVALID: /u);
      }
      await writeFile(join(state, "settings.json"), "{ \"helper\": { \"autoResume\": false ");
      const conflict = await app.inject({ method: "PUT", url: "/settings", payload: { helper: { autoResume: true } } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json<{ message: string }>().message).toMatch(/^SETTINGS_FILE_UNREADABLE: /u);
      expect(await readFile(join(state, "settings.json"), "utf8")).toBe("{ \"helper\": { \"autoResume\": false ");
      // Read as the defaults meanwhile, as the helper reads it.
      expect((await app.inject({ method: "GET", url: "/settings" })).json()).toMatchObject({ helper: { autoResume: true } });
    } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
  });
});
