import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createRun, expectInert, open, shot, viewTab } from "./support.js";

test.describe("Testing execution review", () => {
  test("authority review, plan versus execution and verified change download", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "testing-pass");
    await open(page, runId, "testing");
    const view = page.getByRole("region", { name: "testing execution" });
    await expect(view.getByText(`run ${runId} · COMPLETED · mode execute`)).toBeVisible();
    await expect(view.getByLabel("write partitions")).toContainText("tests/001.test.ts");
    await expect(view.getByLabel("check bindings")).toContainText("/usr/bin/node --test tests/001.test.ts");
    await expect(view.getByText("3 · runtime default")).toBeVisible();
    const table = view.getByLabel("task plan versus execution");
    await expect(table.getByRole("row", { name: /TASK-001/u })).toContainText("1 of 1");
    await expect(view.getByText("execution · passed")).toBeVisible();
    await shot(page, testInfo, "testing-01-authority-and-plan");
    const [download] = await Promise.all([page.waitForEvent("download"), view.getByRole("button", { name: "download verified change set" }).click()]);
    expect(download.suggestedFilename()).toBe(`${runId}-verified-change-set.json`);
    const payload = JSON.parse(await readFile(await download.path(), "utf8")) as { changeSet: { files: { path: string; content: string; contentHash: string; expectedHash: string | null }[] } };
    expect(payload.changeSet.files).toHaveLength(1);
    const [file] = payload.changeSet.files;
    expect(file?.path).toBe("tests/001.test.ts");
    expect(createHash("sha256").update(file?.content ?? "").digest("hex")).toBe(file?.contentHash);
    await expect(view.getByLabel("verified files")).toContainText("tests/001.test.ts · create");
    await shot(page, testInfo, "testing-02-verified-change-set");
    await expectInert(page);
  });

  test("failed checks withhold the handoff", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "testing-failed");
    await open(page, runId, "testing");
    const view = page.getByRole("region", { name: "testing execution" });
    await expect(view.getByText("execution · failed · task_attempts_exhausted:TASK-001")).toBeVisible();
    await view.getByText("TASK-001 · 1 attempts · blocked").click();
    await expect(view.getByText("attempt 1 · frontier · failed")).toBeVisible();
    await expect(view.getByLabel(/checks for TASK-001\/attempt-1/u)).toContainText("t001 · npm run test:001 · failed · exit 1 (expected 0)");
    await expect(view.getByText("no verified change set · withheld until fresh final verification passes")).toBeVisible();
    await expect(view.getByRole("button", { name: "download verified change set" })).toHaveCount(0);
    expect((await request.get(`/runs/${runId}/testing/change-set`)).status()).toBe(404);
    await shot(page, testInfo, "testing-03-failed-checks");
  });

  test("bounded repair is shown with its lineage and recorded subgraph stages", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "testing-repair");
    await open(page, runId, "testing");
    const view = page.getByRole("region", { name: "testing execution" });
    await expect(view.getByLabel("repair rounds")).toContainText("round 1 · reopened");
    await expect(view.getByLabel("repair rounds")).toContainText("failed TASK-001 · reopened TASK-001 · stale TASK-002");
    await expect(view.getByText("1 of 2 repair rounds used")).toBeVisible();
    await view.getByText("TASK-001 · 2 attempts · completed").click();
    await expect(view.getByText(/attempt 2 · frontier · passed · repair of testing-task-verification-/u)).toBeVisible();
    await shot(page, testInfo, "testing-04-repair");
    const [download] = await Promise.all([page.waitForEvent("download"), view.getByRole("button", { name: "download verified change set" }).click()]);
    const payload = JSON.parse(await readFile(await download.path(), "utf8")) as { changeSet: { files: { path: string; content: string }[] } };
    expect(payload.changeSet.files.find(({ path }) => path === "tests/001.test.ts")?.content).toBe("test('001 repaired', () => {});\n");

    // The execution subgraph expands into the stages this run recorded, keyboard first.
    await viewTab(page, "workflow graph").click();
    const stages = page.getByRole("list", { name: "live run stages" });
    const expand = stages.getByRole("button", { name: "expand Guarded test execution · 6 recorded stages" });
    await expand.focus();
    await page.keyboard.press("Enter");
    await expect(stages.getByRole("button", { name: /Bounded repair/u })).toBeVisible();
    await expect(stages.locator("li[data-stage-of='execute']")).toHaveCount(6);
    await expect(page.locator(".react-flow__node", { hasText: "Bounded repair" })).toBeVisible();
    await shot(page, testInfo, "graph-01-expanded-testing-subgraph");
    await stages.getByRole("button", { name: "collapse execute stages" }).press("Enter");
    await expect(stages.locator("li[data-stage-of='execute']")).toHaveCount(0);
  });

  test("a no-work result stays explicit", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "testing-empty");
    await open(page, runId, "testing");
    const view = page.getByRole("region", { name: "testing execution" });
    await expect(view.getByText("no work · analysis selected no gaps, so nothing was written or executed · this is not evidence of test coverage")).toBeVisible();
    await expect(view.getByText("planning · passed · 0 selected gaps")).toBeVisible();
    await expect(view.getByText("no verified change set · no work was selected")).toBeVisible();
    await expect(view.getByLabel("task plan versus execution")).toHaveCount(0);
    await shot(page, testInfo, "testing-05-no-work");
  });
});
