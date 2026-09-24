import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

/** Screenshots are retained evidence: docs/qa/p10/<browser>/<scenario>.jpg. */
export const QA_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/qa/p10");

export async function createRun(request: APIRequestContext, scenario: string): Promise<string> {
  const response = await request.post(`/__fixture/runs/${scenario}`);
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { runId: string }).runId;
}

export async function open(page: Page, runId: string, view: string): Promise<void> {
  // Model text in these runs tries to set this global; it must stay unset.
  await page.addInitScript(() => { (window as unknown as { __arbitraInjected?: unknown }).__arbitraInjected = undefined; });
  if (!dialogs.has(page)) { const seen: string[] = []; dialogs.set(page, seen); page.on("dialog", (dialog) => { seen.push(dialog.message()); void dialog.dismiss(); }); }
  await page.goto(`/?run=${encodeURIComponent(runId)}&view=${view}`);
  await expect(page.getByRole("navigation", { name: "workspace views" })).toBeVisible();
}

export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const directory = resolve(QA_DIRECTORY, testInfo.project.name);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.jpg`), type: "jpeg", quality: 80 });
}

/** Untrusted text rendered as text: no injected element, handler or script ran. */
const dialogs = new WeakMap<Page, string[]>();
export async function expectInert(page: Page): Promise<void> {
  expect(dialogs.get(page) ?? []).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __arbitraInjected?: unknown }).__arbitraInjected)).toBeUndefined();
  expect(await page.locator("img[src='x'], script:not([src])").count()).toBe(0);
}

export function viewTab(page: Page, label: string) {
  return page.getByRole("navigation", { name: "workspace views" }).getByRole("button", { name: label, exact: true });
}

/**
 * A dependency-free accessibility audit of the rendered page: every interactive control has
 * an accessible name, form controls are labelled, images have alt text, IDs are unique,
 * aria-labelledby/aria-controls references resolve, and the page has landmarks and headings.
 */
export async function accessibilityAudit(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const visible = (element: Element): boolean => { const box = (element as HTMLElement).getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
    const name = (element: Element): string => {
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy !== null) return labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      const aria = element.getAttribute("aria-label"); if (aria !== null) return aria.trim();
      const id = element.getAttribute("id");
      const explicit = id === null ? null : document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const wrapping = element.closest("label");
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return (explicit?.textContent ?? wrapping?.textContent ?? element.getAttribute("title") ?? "").trim();
      return (element.textContent ?? element.getAttribute("title") ?? "").trim();
    };
    for (const element of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], summary")) {
      if (!visible(element)) continue;
      if (name(element) === "") problems.push(`unnamed ${element.tagName.toLowerCase()} ${element.outerHTML.slice(0, 120)}`);
    }
    for (const image of document.querySelectorAll("img")) if (!image.hasAttribute("alt")) problems.push(`image without alt ${image.outerHTML.slice(0, 120)}`);
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) problems.push(`duplicate id ${id}`);
    for (const element of document.querySelectorAll("[aria-labelledby], [aria-controls], [aria-describedby]")) {
      for (const attribute of ["aria-labelledby", "aria-controls", "aria-describedby"]) {
        for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/u).filter(Boolean)) if (document.getElementById(id) === null) problems.push(`${attribute} references missing #${id}`);
      }
    }
    if (document.querySelector("main") === null) problems.push("no main landmark");
    if (document.querySelector("h1, h2") === null) problems.push("no heading");
    if (document.documentElement.getAttribute("lang") === null) problems.push("no document language");
    return problems;
  });
}
