import { expect, test } from "@playwright/test";
import { createRun, expectInert, open, shot } from "./support.js";

test.describe("run lifecycle controls", () => {
  test("cancel a live run, then resume it explicitly", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "feature-slow");
    await open(page, runId, "graph");
    const controls = page.getByRole("region", { name: "run controls" });
    await expect(controls.getByText(new RegExp(`run ${runId} · (RUNNING|CREATED) · resumable`, "u"))).toBeVisible();
    await controls.getByRole("button", { name: "cancel" }).click();
    await expect(controls.getByText(`run ${runId} · CANCELLED · resumable`)).toBeVisible();
    await shot(page, testInfo, "lifecycle-01-cancelled");
    await page.reload();
    await expect(controls.getByText(`run ${runId} · CANCELLED · resumable`)).toBeVisible();
    await controls.getByRole("button", { name: "resume" }).click();
    await expect(controls.getByText(`run ${runId} · COMPLETED · not resumable`)).toBeVisible();
  });

  test("a generic human checkpoint is approved, then resumed", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "checkpoint");
    await open(page, runId, "graph");
    const controls = page.getByRole("region", { name: "run controls" });
    const checkpoint = controls.locator(".checkpoint");
    await expect(checkpoint).toContainText("approval · Release the plan? <img src=x");
    await expectInert(page);
    await shot(page, testInfo, "lifecycle-02-human-checkpoint");
    await checkpoint.getByRole("button", { name: "approve" }).click();
    await expect(checkpoint).toHaveCount(0);
    // A second decision for the same version is refused by the server.
    const status = await (await request.get(`/runs/${runId}`)).json() as { checkpoints: { checkpointId: string; version: string; status: string }[] };
    expect(status.checkpoints[0]?.status).toBe("approved");
    expect((await request.post(`/runs/${runId}/checkpoints/approval`, { data: { version: status.checkpoints[0]?.version, decision: "reject" } })).status()).toBe(409);
    await controls.getByRole("button", { name: "resume" }).click();
    await expect(controls.getByText(`run ${runId} · COMPLETED · not resumable`)).toBeVisible();
  });
});
