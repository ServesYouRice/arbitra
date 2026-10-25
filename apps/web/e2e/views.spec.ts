import { expect, test, type Page } from "@playwright/test";
import { accessibilityAudit, createRun, expectInert, open, shot, viewTab } from "./support.js";

/** Visual, keyboard and accessibility QA of a run's tabs over real runs. */
test.describe("run tabs", () => {
  test("issues by verdict, found by file or words, opened from the keyboard with the finder's words marked untrusted", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "audit");
    await open(page, runId, "issues");
    const issues = page.getByRole("region", { name: "issues" });
    await expect(issues.getByText(/^\d+ issues? · \d+ confirmed · \d+ unsettled · \d+ rejected · \d+ not checked$/u)).toBeVisible();
    const verdicts = issues.getByRole("tablist", { name: "verdict" });
    await expect(verdicts.getByRole("tab")).toHaveCount(4);
    // The arrow keys move between the verdicts, as a tab list's do.
    const current = verdicts.getByRole("tab", { selected: true });
    const before = await current.innerText();
    await current.focus();
    await page.keyboard.press("ArrowRight");
    await expect(verdicts.getByRole("tab", { selected: true })).not.toHaveText(before);
    await page.keyboard.press("ArrowLeft");
    await expect(verdicts.getByRole("tab", { selected: true })).toHaveText(before);
    const group = issues.getByRole("tabpanel");
    const rows = group.locator(".issue-row");
    const total = await rows.count();
    expect(total).toBeGreaterThan(0);
    // Find narrows the group to the issues whose title, words or places hold what is typed.
    const place = (await rows.first().locator(".issue-row__place").innerText()).split(":")[0] ?? "";
    await group.getByRole("searchbox", { name: "Find" }).fill(place);
    await expect(group.getByText(/^\d+ of \d+ match$/u)).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(total);
    await group.getByRole("searchbox", { name: "Find" }).fill("");
    // Keyboard: select the first issue; its record opens beside the list and in the address.
    await rows.first().locator(".issue-row__title").focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", { name: /^details · issue /u });
    await expect(details).toBeVisible();
    await expect(page).toHaveURL(/item=issue%3A/u);
    await expect(details.getByRole("region", { name: "evidence" })).toBeVisible();
    await expect(details.getByRole("region", { name: "what was found" }).locator("[data-state='tainted']")).toBeVisible();
    await expect(details.getByRole("region", { name: "the check" })).toBeVisible();
    await expectInert(page);
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-01-issues");
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(page).not.toHaveURL(/item=/u);
  });

  test("the plan's tasks open one click down from the keyboard, and lead to the issues they fix", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "audit");
    await open(page, runId, "plan");
    const tasks = page.getByRole("region", { name: /Fix, in this order · \d+ tasks?$/u });
    await expect(tasks).toBeVisible();
    await tasks.locator(".plan-task__title").first().focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", { name: /^details · task /u });
    await expect(details).toBeVisible();
    await expect(page).toHaveURL(/item=trace%3Atask%3A/u);
    const fixes = details.getByRole("region", { name: "what it fixes" });
    await expect(fixes).toBeVisible();
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-02-plan-task");
    const issue = fixes.getByRole("link").first();
    if (await issue.count() === 0) return;
    await issue.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/view=issues&item=issue%3A/u);
    await expect(page.getByRole("complementary", { name: /^details · issue /u })).toBeVisible();
  });

  test("evaluation keeps unknown measurements unknown", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "testing-pass");
    await open(page, runId, "evaluation");
    const evaluation = page.getByRole("region", { name: "evaluation" });
    await expect(evaluation.getByText(/model activity attempts/u)).toBeVisible();
    const perRun = evaluation.getByLabel("per-run evaluation");
    // No pricing and no ground truth: cost and precision are unavailable, never zero.
    await expect(perRun.locator("div", { hasText: "total cost" }).locator("dd")).toHaveText(/^unavailable/u);
    await expect(perRun.locator("div", { hasText: "consensus precision" }).locator("dd")).toHaveText("unavailable");
    await expect(evaluation.getByLabel("per-auditor contribution").locator("td", { hasText: /^unavailable$/u }).first()).toBeVisible();
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-03-evaluation-unknown");
  });

  test("the activity tab pages and filters model attempts and opens their historical artifacts", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "testing-wide");
    await open(page, runId, "activity");
    const traces = page.getByRole("region", { name: "trace browser" });
    const summary = traces.getByText(/matching model activity attempts/u);
    await expect(summary).toBeVisible();
    const total = Number(/^(\d+)/u.exec(await summary.innerText())?.[1]);
    expect(total).toBeGreaterThan(25);
    const rows = traces.getByRole("table", { name: "model activity attempts" }).locator("tbody tr");
    await expect(rows).toHaveCount(25);
    await traces.getByRole("button", { name: "next attempts" }).click();
    await expect(rows).toHaveCount(total - 25);
    await expect(traces.getByRole("button", { name: "next attempts" })).toBeDisabled();
    await traces.getByRole("button", { name: "previous attempts" }).click();
    await expect(rows).toHaveCount(25);
    await traces.getByLabel("activity contains").fill("testing/writer");
    await expect(summary).toHaveText(/^[1-9]\d* matching/u);
    const filtered = Number(/^(\d+)/u.exec(await summary.innerText())?.[1]);
    expect(filtered).toBeLessThan(total);
    await traces.getByLabel("outcome").selectOption("error");
    await expect(traces.getByText("no recorded attempts match these filters")).toBeVisible();
    await traces.getByLabel("outcome").selectOption("");
    await rows.first().getByRole("button").click();
    await expect(page).toHaveURL(/item=attempt%3A/u);
    const detail = page.getByRole("complementary", { name: /^details · model attempt / }).getByRole("region", { name: "attempt details" });
    await expect(detail.locator("div", { hasText: /^cost USD/u }).locator("dd")).toHaveText("unavailable");
    await detail.getByRole("button", { name: "output" }).click();
    await expect(detail.getByRole("article", { name: "trace artifact" })).toContainText("untrusted data");
    await detail.getByRole("button", { name: "input 1" }).click();
    await expect(detail.getByRole("article", { name: "trace artifact" }).locator("pre")).not.toBeEmpty();
    await expectInert(page);
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-04-trace-browser");
  });

  test("keyboard-only navigation across every tab with visible focus", async ({ page, request, browserName }, testInfo) => {
    // macOS WebKit (like Safari's default) moves Tab between form fields only; Option+Tab
    // reaches every control. That is the platform's keyboard model, not a skipped control.
    const next = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
    const runId = await createRun(request, "feature-blocked");
    await open(page, runId, "summary");
    const tabs = ["Summary", "Requirements", "Plan", "How it ran"];
    await expect(page.getByRole("navigation", { name: "run views" }).getByRole("link")).toHaveText(tabs);
    await viewTab(page, "Summary").focus();
    for (const [index, label] of tabs.entries()) {
      if (index > 0) await page.keyboard.press(next);
      await expect(viewTab(page, label)).toBeFocused();
      await expect.poll(() => focusOutline(page)).not.toBe("none");
    }
    await viewTab(page, "Requirements").focus();
    await page.keyboard.press("Enter");
    await expect(viewTab(page, "Requirements")).toHaveAttribute("aria-current", "page");
    // Reach the approval checkbox, toggle it, and find the decision it enables right after it.
    const checkbox = page.getByLabel("approve default for migration");
    for (let presses = 0; presses < 40 && !(await checkbox.evaluate((element) => element === document.activeElement)); presses += 1) await page.keyboard.press(next);
    await expect(checkbox).toBeFocused();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await page.keyboard.press(next);
    await expect(page.getByRole("button", { name: "approve selected defaults" })).toBeFocused();
    await shot(page, testInfo, "keyboard-01-focus-visible");
    for (const label of tabs) {
      await viewTab(page, label).focus();
      await page.keyboard.press("Enter");
      await expect(viewTab(page, label)).toHaveAttribute("aria-current", "page");
      await page.waitForLoadState("networkidle");
      expect(await accessibilityAudit(page), label).toEqual([]);
    }
    // The records are one keyboard step down from How it ran, and each passes the same audit.
    await viewTab(page, "How it ran").focus();
    await page.keyboard.press("Enter");
    for (const record of ["Evaluation", "Activity"]) {
      await page.getByRole("region", { name: "Records" }).getByRole("link", { name: record, exact: true }).or(page.getByRole("navigation", { name: "records" }).getByRole("link", { name: record, exact: true })).first().focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("navigation", { name: "records" }).getByRole("link", { name: record, exact: true })).toHaveAttribute("aria-current", "page");
      await page.waitForLoadState("networkidle");
      expect(await accessibilityAudit(page), record).toEqual([]);
    }
    // The graph's recorded stages are reachable and selectable from the stage list.
    const stages = page.getByRole("list", { name: "live run stages" });
    await stages.getByRole("button", { name: /expand Requirements, exploration and planning/u }).press("Enter");
    const stage = stages.getByRole("button", { name: /Requirements draft/u });
    await stage.press("Enter");
    await expect(stage).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("complementary", { name: "details · Requirements draft" })).toBeVisible();
    await shot(page, testInfo, "graph-02-feature-stages-keyboard");
  });
});

async function focusOutline(page: Page): Promise<string> {
  return page.evaluate(() => { const element = document.activeElement; return element === null ? "none" : getComputedStyle(element).outlineStyle; });
}
