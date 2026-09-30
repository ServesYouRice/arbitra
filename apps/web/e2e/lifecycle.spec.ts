import { expect, test } from "@playwright/test";
import { createRun, expectInert, open, shot, stateChip } from "./support.js";

test.describe("run lifecycle controls", () => {
  test("cancel a live run from its header, then resume it explicitly", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "feature-slow");
    await open(page, runId, "overview");
    await expect(stateChip(page)).toHaveText(/^(running · .+|starting) [A-Z_]+$/u);
    await page.getByRole("button", { name: "cancel run" }).click();
    await expect(stateChip(page)).toHaveText("cancelled CANCELLED");
    await expect(page.getByRole("region", { name: "result" })).toContainText("The run was cancelled. Resume it from the header");
    await shot(page, testInfo, "lifecycle-01-cancelled");
    await page.reload();
    await expect(stateChip(page)).toHaveText("cancelled CANCELLED");
    await page.getByRole("button", { name: "resume run" }).click();
    await expect(stateChip(page)).toHaveText("finished COMPLETED");
    await expect(page.getByRole("button", { name: "resume run" })).toHaveCount(0);
  });

  test("a generic human checkpoint waits in the banner above every tab, is approved, then resumed", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "checkpoint");
    await open(page, runId, "issues");
    const banner = page.getByRole("region", { name: "This run is waiting for your decision" });
    await expect(banner).toContainText("Release the plan? <img src=x");
    await expect(stateChip(page)).toHaveText("waiting for your decision BLOCKED");
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
    await expect(stateChip(page)).toHaveText("finished COMPLETED");
    await expect(banner).toHaveCount(0);
  });
});
