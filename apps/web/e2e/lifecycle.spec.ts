import { expect, test } from "@playwright/test";
import { createRun, expectInert, open, shot, stateChip } from "./support.js";

test.describe("run lifecycle controls", () => {
  test("cancel a live run from its header, then resume it explicitly", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "feature-slow");
    await open(page, runId, "summary");
    await expect(stateChip(page)).toHaveText("running");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(stateChip(page)).toHaveText("cancelled");
    await expect(page.getByRole("region", { name: "Cancelled" })).toContainText("The run was cancelled. What it finished is kept: resume it from the header");
    await shot(page, testInfo, "lifecycle-01-cancelled");
    await page.reload();
    await expect(stateChip(page)).toHaveText("cancelled");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(stateChip(page)).toHaveText("done");
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  });

  test("a generic human checkpoint waits in the banner above every tab, is approved, then resumed", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "checkpoint");
    await open(page, runId, "issues");
    const banner = page.getByRole("region", { name: "This run is waiting for your decision" });
    await expect(banner).toContainText("Release the plan? <img src=x");
    await expect(stateChip(page)).toHaveText("needs you");
    await expect(banner.getByRole("button", { name: "resume run" })).toBeDisabled();
    await expectInert(page);
    await shot(page, testInfo, "lifecycle-02-human-checkpoint");
    await banner.getByRole("button", { name: "approve" }).click();
    await expect(banner.getByText("checkpoint approval · approved")).toBeVisible();
    // A second decision for the same version is refused by the server.
    const status = await (await request.get(`/runs/${runId}`)).json() as { checkpoints: { checkpointId: string; version: string; status: string }[] };
    expect(status.checkpoints[0]?.status).toBe("approved");
    expect((await request.post(`/runs/${runId}/checkpoints/approval`, { data: { version: status.checkpoints[0]?.version, decision: "reject" } })).status()).toBe(409);
    await banner.getByRole("button", { name: "resume run" }).click();
    await expect(stateChip(page)).toHaveText("done");
    await expect(banner).toHaveCount(0);
  });
});
