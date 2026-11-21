// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App.js";
import { json, stubBrowser, stubControlPlane, visit } from "../support.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); visit(""); });

const DEFAULTS = { helper: { autoResume: true, model: { transport: "claude-code-cli", modelId: "claude-opus-5-5" } } };
/** Antigravity on this computer offers Argon, which joins its list first, as on New run. */
const ENVIRONMENT = { build: "test", clis: [{ transport: "antigravity-cli", name: "Antigravity", state: "ready", version: "1.0.0", note: "", fix: null, models: [{ id: "gemini-4-argon", name: "Gemini 4 Argon" }] }], apiKeys: {} };

/** The settings route as the server keeps it: a change merges into what it had. */
function settingsRoute(initial: typeof DEFAULTS | { readonly helper: { readonly autoResume: boolean; readonly model: { readonly transport: string; readonly modelId: string } } }): { readonly routes: Record<string, unknown>; readonly saved: unknown[] } {
  let settings = initial;
  const saved: unknown[] = [];
  return { saved, routes: {
    "GET /settings": () => settings,
    "PUT /settings": ({ body }: { readonly body: unknown }) => { saved.push(body); settings = { helper: { ...settings.helper, ...(body as { readonly helper: object }).helper } }; return settings; },
    "GET /diagnostics/environment": ENVIRONMENT,
  } };
}

describe("the Settings page", () => {
  it("shows the run helper's settings and saves each change as it is made", async () => {
    stubBrowser();
    const server = settingsRoute(DEFAULTS);
    stubControlPlane(server.routes);
    visit("?page=settings");
    render(<App />);
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
    const helper = await screen.findByRole("region", { name: "run helper" });
    const resume = within(helper).getByRole("checkbox", { name: /^resume stopped runs/u });
    expect((resume as HTMLInputElement).checked).toBe(true);
    const model = within(helper).getByRole("combobox", { name: "helper's model" });
    expect((model as HTMLSelectElement).value).toBe("claude-code-cli|claude-opus-5-5");
    // The lists are the ones a lineup's profiles choose from, grouped by the route that reaches them.
    expect([...model.querySelectorAll("optgroup")].map(({ label }) => label)).toEqual(["through Claude Code", "through Anthropic API", "through Codex", "through OpenAI API", "through Antigravity", "through Gemini API"]);
    const claudeCode = model.querySelector("optgroup");
    expect(claudeCode === null ? [] : within(claudeCode).getAllByRole("option").map(({ textContent }) => textContent)).toEqual(["Opus 5.5 (recommended) · strongest, slowest", "Sonnet 5.5 · balanced", "Haiku 5.5 · fast, light on usage", "Sonnet 5 · previous Sonnet", "Haiku 4.5 · previous Haiku"]);

    fireEvent.click(resume);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "saved");
    expect((resume as HTMLInputElement).checked).toBe(false);
    expect(server.saved).toEqual([{ helper: { autoResume: false } }]);

    // What Antigravity offers here is listed too, and chosen like any other.
    const argon = await within(model).findByRole("option", { name: "Gemini 4 Argon (recommended) · earlier frontier, its own weekly limit" });
    fireEvent.change(model, { target: { value: (argon as HTMLOptionElement).value } });
    await waitFor(() => { expect(server.saved).toHaveLength(2); });
    expect(server.saved[1]).toEqual({ helper: { model: { transport: "antigravity-cli", modelId: "gemini-4-argon" } } });
    await waitFor(() => { expect((model as HTMLSelectElement).value).toBe("antigravity-cli|gemini-4-argon"); });
    expect((resume as HTMLInputElement).checked).toBe(false);
  });

  it("keeps a model no list has as its own choice, and says why a change was not saved", async () => {
    stubBrowser();
    stubControlPlane({
      "GET /settings": { helper: { autoResume: false, model: { transport: "codex-cli", modelId: "gpt-7-nova" } } },
      "PUT /settings": json({ statusCode: 409, error: "Conflict", message: "SETTINGS_FILE_UNREADABLE: settings.json is not a JSON object" }, 409),
      "GET /diagnostics/environment": json({ message: "not read" }, 500),
    });
    visit("?page=settings");
    render(<App />);
    const helper = await screen.findByRole("region", { name: "run helper" });
    const model = within(helper).getByRole("combobox", { name: "helper's model" });
    expect((model as HTMLSelectElement).value).toBe("codex-cli|gpt-7-nova");
    expect(within(model).getByRole("option", { name: "GPT-7 Nova through Codex (as settings.json names it)" })).toBeTruthy();
    // Without the environment the lists are arbitra's own.
    expect(within(model).queryByRole("option", { name: /Argon/u })).toBeNull();

    const resume = within(helper).getByRole("checkbox", { name: /^resume stopped runs/u });
    fireEvent.click(resume);
    expect((await screen.findByRole("alert")).textContent).toBe("Not saved · SETTINGS_FILE_UNREADABLE: settings.json is not a JSON object (SETTINGS_API_409)");
    expect((resume as HTMLInputElement).checked).toBe(false);
  });

  it("says when the settings cannot be read", async () => {
    stubBrowser();
    stubControlPlane({ "GET /settings": json({ message: "EACCES" }, 500), "GET /diagnostics/environment": ENVIRONMENT });
    visit("?page=settings");
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toBe("The settings could not be read · EACCES (SETTINGS_API_500)");
    expect(screen.queryByRole("region", { name: "run helper" })).toBeNull();
  });
});
