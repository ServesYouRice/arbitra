import { expect, test, type Page } from "@playwright/test";
import { accessibilityAudit, createRun, expectInert, open, shot, viewTab } from "./support.js";

/** Visual, keyboard and accessibility QA of the existing run views over real runs. */
test.describe("existing run views", () => {
  test("issue board filters, expansion and untrusted evidence", async ({ page, request }, testInfo) => {
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
    for (const row of await board.locator(".issue-row").all()) await expect(row).toContainText(`severity ${severity}`);
    await board.getByRole("button", { name: "clear filters" }).click();
    await expect(count).toHaveText(`${total} of ${total} canonical issues shown`);
    const first = board.locator(".issue-row__title").first();
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(board.locator(".issue-row__evidence").first()).toBeVisible();
    await expectInert(page);
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-01-issue-board");
  });

  test("plan traceability is navigable from the keyboard", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "audit");
    await open(page, runId, "plan");
    const plan = page.getByRole("region", { name: "plan" });
    await expect(plan.getByText(/tasks and capability routing/iu)).toBeVisible();
    const task = plan.locator(".plan-task button").first();
    await task.focus();
    await page.keyboard.press("Enter");
    await expect(plan.getByLabel("traceability trail")).toBeVisible();
    await expect(plan.getByText(/forward|backward/u).first()).toBeVisible();
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

  test("trace browser pages, filters and opens historical attempt artifacts", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "testing-wide");
    await open(page, runId, "traces");
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
    const detail = traces.getByRole("region", { name: "attempt details" });
    await expect(detail.locator("div", { hasText: /^cost USD/u }).locator("dd")).toHaveText("unavailable");
    await detail.getByRole("button", { name: "output" }).click();
    await expect(detail.getByRole("article", { name: "trace artifact" })).toContainText("untrusted data");
    await detail.getByRole("button", { name: "input 1" }).click();
    await expect(detail.getByRole("article", { name: "trace artifact" }).locator("pre")).not.toBeEmpty();
    await expectInert(page);
    expect(await accessibilityAudit(page)).toEqual([]);
    await shot(page, testInfo, "views-04-trace-browser");
  });

  test("keyboard-only navigation across every view with visible focus", async ({ page, request, browserName }, testInfo) => {
    // macOS WebKit (like Safari's default) moves Tab between form fields only; Option+Tab
    // reaches every control. That is the platform's keyboard model, not a skipped control.
    const next = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
    const runId = await createRun(request, "feature-blocked");
    await open(page, runId, "graph");
    const tabs = ["workflow graph", "issue board", "plan", "feature contract", "testing execution", "evaluation", "traces"];
    await viewTab(page, "workflow graph").focus();
    for (const [index, label] of tabs.entries()) {
      if (index > 0) await page.keyboard.press(next);
      await expect(viewTab(page, label)).toBeFocused();
      await expect.poll(() => focusOutline(page)).not.toBe("none");
    }
    await viewTab(page, "feature contract").focus();
    await page.keyboard.press("Enter");
    await expect(viewTab(page, "feature contract")).toHaveAttribute("aria-current", "page");
    // Reach the approval checkbox and toggle it without a pointer.
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
      await page.keyboard.press("Space");
      await expect(viewTab(page, label)).toHaveAttribute("aria-current", "page");
      await page.waitForLoadState("networkidle");
      expect(await accessibilityAudit(page), label).toEqual([]);
    }
    // The graph's recorded stages are reachable and selectable from the stage list.
    await viewTab(page, "workflow graph").focus();
    await page.keyboard.press("Enter");
    const stages = page.getByRole("list", { name: "live run stages" });
    await stages.getByRole("button", { name: /expand Requirements, exploration and planning/u }).press("Enter");
    const stage = stages.getByRole("button", { name: /Requirements draft/u });
    await stage.press("Enter");
    await expect(stage).toHaveAttribute("aria-pressed", "true");
    await shot(page, testInfo, "graph-02-feature-stages-keyboard");
  });
});

async function focusOutline(page: Page): Promise<string> {
  return page.evaluate(() => { const element = document.activeElement; return element === null ? "none" : getComputedStyle(element).outlineStyle; });
}
