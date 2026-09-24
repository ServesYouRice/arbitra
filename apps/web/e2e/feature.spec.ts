import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createRun, expectInert, open, shot } from "./support.js";

test.describe("Feature contract controls", () => {
  test("blocked approval, stale refusal, reload, explicit resume and handoff retrieval", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "feature-blocked");
    await open(page, runId, "feature");
    const view = page.getByRole("region", { name: "feature contract" });
    await expect(view.getByText(`run ${runId} · BLOCKED · resumable`)).toBeVisible();
    await expect(view.getByText("approval pending")).toBeVisible();
    // Model-authored contract text is shown literally and does nothing.
    await expect(view.getByText(/Keep existing sessions <img src=x onerror=/u)).toBeVisible();
    await expectInert(page);
    await shot(page, testInfo, "feature-01-blocked-contract");

    // Another operator revises the contract after this page loaded it.
    const loaded = await (await request.get(`/runs/${runId}/requirements`)).json() as { artifactId: string; contract: { assumptions: unknown[]; ambiguities: { id: string }[]; acceptance: unknown[]; outOfScope: unknown[] } };
    const revised = await request.post(`/runs/${runId}/requirements/revise`, { data: { artifactId: loaded.artifactId, draft: { assumptions: loaded.contract.assumptions, acceptance: loaded.contract.acceptance, outOfScope: loaded.contract.outOfScope,
      ambiguities: loaded.contract.ambiguities.map((item) => item.id === "migration" ? { ...item, proposedDefault: "Expire sessions" } : item) } } });
    expect(revised.status()).toBe(200);

    await view.getByLabel("approve default for migration").check();
    await view.getByRole("button", { name: "approve selected defaults" }).click();
    const alert = view.getByRole("alert");
    await expect(alert).toContainText("stale · refused by the server · STALE_REQUIREMENTS_CHECKPOINT");
    await shot(page, testInfo, "feature-02-stale-approval");
    await alert.getByRole("button", { name: "reload contract" }).click();
    await expect(view.getByText("proposed default · Expire sessions")).toBeVisible();

    await view.getByLabel("approve default for migration").check();
    await view.getByRole("button", { name: "approve selected defaults" }).click();
    await expect(view.getByText("accepted by operator")).toBeVisible();
    // Approval did not resume anything; a reload shows the durable decision on a still-blocked run.
    await page.reload();
    await expect(view.getByText(`run ${runId} · BLOCKED · resumable`)).toBeVisible();
    await expect(view.getByText("accepted by operator")).toBeVisible();

    await view.getByRole("button", { name: "resume run" }).click();
    await expect(view.getByText(`run ${runId} · COMPLETED · not resumable`)).toBeVisible();
    await expect(view.getByText("plan gate · passed")).toBeVisible();
    await page.reload();
    await expect(view.getByText(`run ${runId} · COMPLETED · not resumable`)).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), view.getByRole("button", { name: "download implementation handoff" }).click()]);
    expect(download.suggestedFilename()).toBe(`${runId}-implementation.json`);
    const tree = JSON.parse(await readFile(await download.path(), "utf8")) as Record<string, string>;
    expect(JSON.parse(tree["manifest.json"] ?? "{}")).toMatchObject({ run: { mode: "feature" } });
    await expectInert(page);
    await shot(page, testInfo, "feature-03-completed-handoff");
  });

  test("revision proposal is inspected, applied, re-approved and resumed", async ({ page, request }, testInfo) => {
    const runId = await createRun(request, "feature-proposal");
    await open(page, runId, "feature");
    const view = page.getByRole("region", { name: "feature contract" });
    await view.getByLabel("approve default for migration").check();
    await view.getByRole("button", { name: "approve selected defaults" }).click();
    await expect(view.getByText("accepted by operator")).toBeVisible();
    await view.getByRole("button", { name: "resume run" }).click();
    // Independent review stays unresolved; the model proposal is shown but not applied.
    await expect(view.getByRole("heading", { name: "model revision proposal · not applied" })).toBeVisible();
    await expect(view.getByLabel("proposed changes")).toContainText("migration · proposedDefault · Keep sessions → Keep sessions (revised)");
    await expect(view.getByText(`run ${runId} · BLOCKED · resumable`)).toBeVisible();
    await shot(page, testInfo, "feature-04-revision-proposal");
    await view.getByRole("button", { name: "apply proposal" }).click();
    await expect(view.getByText("proposal applied · approve the new defaults before resuming")).toBeVisible();
    await expect(view.getByText("proposed default · Keep sessions (revised)")).toBeVisible();
    await expect(view.getByText("approval pending")).toBeVisible();
    await view.getByLabel("approve default for migration").check();
    await view.getByRole("button", { name: "approve selected defaults" }).click();
    await expect(view.getByText("accepted by operator")).toBeVisible();
    await view.getByRole("button", { name: "resume run" }).click();
    await expect(view.getByText(`run ${runId} · COMPLETED · not resumable`)).toBeVisible();
    await expect(view.getByRole("button", { name: "download implementation handoff" })).toBeVisible();
    await expectInert(page);
  });

  test("an operator draft revision replaces the contract and clears approvals", async ({ page, request }) => {
    const runId = await createRun(request, "feature-blocked");
    await open(page, runId, "feature");
    const view = page.getByRole("region", { name: "feature contract" });
    await view.getByRole("button", { name: "revise draft" }).click();
    const editor = view.getByLabel("draft JSON");
    const draft = JSON.parse(await editor.inputValue()) as { ambiguities: { id: string; proposedDefault: string }[] };
    draft.ambiguities = draft.ambiguities.map((item) => item.id === "migration" ? { ...item, proposedDefault: "Migrate lazily" } : item);
    await editor.fill(JSON.stringify(draft));
    await view.getByRole("button", { name: "submit revision" }).click();
    await expect(view.getByText("revision recorded · earlier approvals cleared")).toBeVisible();
    await expect(view.getByText("proposed default · Migrate lazily")).toBeVisible();
    await expect(view.getByText("approval pending")).toBeVisible();
  });
});
