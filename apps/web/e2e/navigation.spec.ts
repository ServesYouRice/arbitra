import { expect, test } from "@playwright/test";
import { accessibilityAudit, coveredControls, createRun, expectInert, guard, open, shot, stateChip, viewTab } from "./support.js";

/**
 * The ways into and around the interface that the old single screen lacked: a list of runs,
 * addresses that survive a reload and the back button, a form that starts a run, and a
 * layout whose controls stay reachable at laptop and narrow widths.
 */
test.describe("finding, starting and reading runs", () => {
  test("the run list opens a run, and every tab and selection is an address", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "audit");
    await guard(page);
    await page.goto("/");
    const table = page.getByRole("table", { name: "runs" });
    const row = table.getByRole("row").filter({ has: page.getByRole("link", { name: `open run ${runId}` }) });
    await expect(row).toContainText("finished COMPLETED");
    await expect(row).toContainText("scripted detectors, no model calls");
    await expect(row).toContainText("gate failed");
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "navigation-01-run-list");
    await row.getByRole("link", { name: `open run ${runId}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Audit run · audit-deep" })).toBeVisible();
    await expect(page.getByRole("region", { name: "result" })).toContainText("coverage is incomplete");
    await viewTab(page, "Issues").click();
    await expect(page).toHaveURL(new RegExp(`\\?run=${runId}&view=issues$`, "u"));
    await page.locator(".issue-row__title").first().click();
    await expect(page).toHaveURL(/item=issue%3A/u);
    // The back button walks tabs, not selections: a selection replaces its tab's entry.
    await page.goBack();
    await expect(viewTab(page, "Overview")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("complementary", { name: /^details/u })).toHaveCount(0);
    await page.goForward();
    await expect(viewTab(page, "Issues")).toHaveAttribute("aria-current", "page");
    // A reload keeps the tab and the open issue. (Back is checked above, before the reload:
    // Firefox under Playwright keeps no earlier entry across a reload.)
    await page.reload();
    await expect(page.getByRole("complementary", { name: /^details · issue /u })).toBeVisible();
    await expect(viewTab(page, "Issues")).toHaveAttribute("aria-current", "page");
    await page.getByRole("navigation", { name: "main" }).getByRole("link", { name: "Runs" }).click();
    await expect(table).toBeVisible();
    await expectInert(page);
  });

  test("a scripted run is checked and started from the new-run page", async ({ page, request }, testInfo) => {
    const { repository } = await (await request.post("/__fixture/repositories/audit")).json() as { repository: string };
    await guard(page);
    await page.goto("/?page=new-run");
    await expect(page.getByLabel("starting point")).toHaveValue("template:scripted-audit");
    await expect(page.getByText("no models · the auditors are deterministic detectors")).toBeVisible();
    await page.getByLabel("repository path").fill(repository);
    await page.getByRole("button", { name: "check configuration" }).click();
    const result = page.getByRole("region", { name: "check result" });
    await expect(result).toContainText("ready to start");
    await expect(result).toContainText("calls no model · scripted detectors");
    await expect(result.getByLabel("estimate")).toContainText("scripted auditors make no provider calls");
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "navigation-02-new-run-checked");
    await page.getByLabel("configuration name").fill(`smoke-${testInfo.project.name}`);
    await page.getByRole("button", { name: "save and start" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Audit run · audit-deep" })).toBeVisible();
    await expect(stateChip(page)).toHaveText("finished COMPLETED");
    // The server records the real path (on macOS /var is /private/var), so compare its unique tail.
    await expect(page.locator(".run-header__meta")).toContainText(repository.split("/").slice(-2).join("/"));
  });

  test("a model-backed template lists what is left to fill in, and preflight refuses it until it is", async ({ page }, testInfo) => {
    await guard(page);
    await page.goto("/?page=new-run&from=template:subscription-audit");
    const open = page.getByRole("list", { name: "placeholders to fill in" });
    await expect(open.getByRole("listitem")).toHaveCount(6);
    await page.getByLabel("model ID for auditor-a").fill("fixture-model-a");
    await expect(open.getByRole("listitem")).toHaveCount(5);
    await page.getByRole("button", { name: "save and start" }).click();
    const result = page.getByRole("region", { name: "check result" });
    await expect(result).not.toContainText("ready to start");
    await expect(page.getByText("Starting needs a configuration that passes preflight; fix the problems above first.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "New run" })).toBeVisible();
    await shot(page, testInfo, "navigation-03-template-refused");
  });

  for (const width of [1100, 800]) {
    test(`no control is covered at ${width}px, and the details panel is a drawer there`, async ({ page, request }, testInfo) => {
      const runId = await createRun(request, "audit");
      await page.setViewportSize({ width, height: 900 });
      for (const view of ["overview", "issues", "activity"]) {
        await open(page, runId, view);
        await page.waitForLoadState("networkidle");
        expect(await coveredControls(page), `${view} at ${width}px`).toEqual([]);
      }
      await page.goto("/?page=new-run");
      await expect(page.getByRole("heading", { level: 1, name: "New run" })).toBeVisible();
      expect(await coveredControls(page), `new run at ${width}px`).toEqual([]);
      await open(page, runId, "issues");
      await page.locator(".issue-row__title").first().click();
      const drawer = page.getByRole("dialog", { name: /^details · issue /u });
      await expect(drawer).toHaveAttribute("aria-modal", "true");
      await expect(drawer.getByRole("button", { name: "close details" })).toBeFocused();
      await shot(page, testInfo, `navigation-04-drawer-${width}`);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
    });
  }
});
