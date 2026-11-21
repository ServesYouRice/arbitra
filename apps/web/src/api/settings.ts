import { failureText } from "./runs.js";

/** A model by the route that reaches it, as `helper.model` names it. */
export interface HelperModel { readonly transport: string; readonly modelId: string }
/** The run helper's settings, with the server's defaults for what `<state>/settings.json` does not say. */
export interface HelperSettings { readonly autoResume: boolean; readonly model: HelperModel }
export interface Settings { readonly helper: HelperSettings }

/** This computer's settings for arbitra (`GET` and `PUT /settings`; apps/server/src/settings.ts). */
export class SettingsApi {
  constructor(private readonly baseUrl = "") {}
  load(): Promise<Settings> { return this.request("/settings"); }
  /** Saves the settings named, leaves the others as they are, and answers with them all. */
  save(helper: Partial<HelperSettings>): Promise<Settings> { return this.request("/settings", { method: "PUT", body: JSON.stringify({ helper }) }); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers } });
    if (!response.ok) throw new Error(await failureText(response, `SETTINGS_API_${response.status}`));
    return await response.json() as T;
  }
}
