import type { FastifyInstance } from "fastify";
import { readHelperSettings, saveHelperSettings } from "@arbitra/runtime/run-helper.js";

/**
 * This computer's settings for arbitra, a route of the local app: the run helper's part of `<state>/settings.json`
 * (`helper.autoResume`, `helper.model`; see packages/runtime/src/run-helper.ts). The helper reads the file at each
 * decision, so a change saved here counts without a restart. Writes only the settings file.
 */
export function registerSettingsRoutes(app: FastifyInstance, stateDirectory: string): void {
  app.get("/settings", async () => ({ helper: await readHelperSettings(stateDirectory) }));
  app.put("/settings", async (request) => ({ helper: await saveHelperSettings(stateDirectory, request.body) }));
}
