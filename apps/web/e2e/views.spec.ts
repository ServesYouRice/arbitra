import { expect, test, type Page } from "@playwright/test";
import { accessibilityAudit, createRun, expectInert, open, shot, viewTab } from "./support.js";

/** Visual, keyboard and accessibility QA of a run's tabs over real runs. */
test.describe("run tabs", () => {
  test("issue board filters, row selection and untrusted evidence in the details panel", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "audit");
    await open(page, runId, "issues");
    const board = page.getByRole("region", { name: "issue board" });
    const count = board.getByText(/^\d+ of \d+ canonical issues shown$/u);
    await expect(count).toBeVisible();
    const total = Number(/of (\d+)/u.exec(await count.innerText())?.[1]);
    expect(total).toBeGreaterThan(0);
    const severities = await board.getByLabel("severity", { exact: true }).locator("option").allInnerTexts();
    const severity = severities.find((value) => value !== "any");
    if (severity === undefined) throw new Error("NO_SEVERITY_OPTION");
    await board.getByLabel("severity", { exact: true }).selectOption(severity);
    const filtered = Number(/^(\d+)/u.exec(await count.innerText())?.[1]);
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThanOrEqual(total);
    await expect(board.locator(".issue-row")).toHaveCount(filtered);
    for (const row of await board.locator(".issue-row").all()) await expect(row.locator(".issue-row__severity")).toContainText(severity);
    await board.getByRole("button", { name: "clear filters" }).click();
    await expect(count).toHaveText(`${total} of ${total} canonical issues shown`);
    // Keyboard: select the first issue; its full record opens beside the board and in the address.
    await board.locator(".issue-row__title").first().focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", { name: /^details · issue /u });
    await expect(details).toBeVisible();
    await expect(page).toHaveURL(/item=issue%3A/u);
    const finding = details.getByRole("region", { name: "source findings" }).locator("summary").first();
    await finding.click();
    await expect(details.getByRole("list", { name: /^evidence for / }).first()).toBeVisible();
    await expect(details.getByRole("region", { name: "claim" }).locator("[data-state='tainted']")).toBeVisible();
    await expectInert(page);
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-01-issue-board");
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(page).not.toHaveURL(/item=/u);
  });

  test("plan traceability is navigable from the keyboard", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "audit");
    await open(page, runId, "plan");
    const plan = page.getByRole("region", { name: "plan" });
    await expect(plan.getByText(/tasks and capability routing/iu)).toBeVisible();
    await plan.getByRole("table", { name: "plan tasks" }).getByRole("button").first().focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("complementary", { name: /^details · task /u });
    await expect(details.getByLabel("traceability trail")).toBeVisible();
    const forward = details.getByRole("region", { name: "forward links" }).getByRole("button").first();
    await forward.focus();
    await page.keyboard.press("Enter");
    // Each step is the new selection, so the panel is now named for the node reached.
    await expect(page.getByRole("complementary", { name: /^details · validation /u }).getByLabel("traceability trail").locator("li")).toHaveCount(2);
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-02-plan-traceability");
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
    await open(page, runId, "overview");
    const tabs = ["Overview", "Requirements", "Plan", "Activity", "Evaluation"];
    await expect(page.getByRole("navigation", { name: "run views" }).getByRole("link")).toHaveText(tabs);
    await viewTab(page, "Overview").focus();
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
    // The graph's recorded stages are reachable and selectable from the stage list.
    await viewTab(page, "Activity").focus();
    await page.keyboard.press("Enter");
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
