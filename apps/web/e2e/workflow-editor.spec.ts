import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { accessibilityAudit, expectInert, viewTab } from "./support.js";

/**
 * Browser acceptance for operator-authored workflow graphs (completion plan P16).
 *
 * The real control plane validates and versions every graph; the runs are produced by the
 * real orchestrator with credential-free scripted auditors. One server serves every
 * browser project, so graph and configuration names carry the project name.
 */
const QA = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/qa/p16");
const UNTRUSTED = `<img src=x onerror="window.__arbitraInjected=1">`;

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const directory = resolve(QA, testInfo.project.name);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.jpg`), type: "jpeg", quality: 80, fullPage: true });
}

async function openEditor(page: Page): Promise<Locator> {
  await page.addInitScript(() => { (window as unknown as { __arbitraInjected?: unknown }).__arbitraInjected = undefined; });
  // The unsaved-changes guard is an in-page dialog; no native dialog may open.
  page.on("dialog", (dialog) => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.goto("/?view=graph");
  await page.getByRole("group", { name: "graph mode" }).getByRole("button", { name: "edit graph" }).click();
  // The region's name follows the graph ID, which the tests rename.
  const editor = page.getByRole("region", { name: /^workflow graph · editing /u });
  await expect(editor.getByRole("heading", { name: "workflow graph · editing audit-deep" })).toBeVisible();
  // The unchanged preset template is rejected by the server until it is renamed.
  await expect(validation(editor)).toContainText("invalid · 1 diagnostic");
  await expect(editor.getByRole("list", { name: "validation diagnostics" })).toContainText("UNAUTHORIZED_CHANGE · $.id");
  return editor;
}

const nativeDialogs: string[] = [];
test.afterEach(() => { expect(nativeDialogs.splice(0)).toEqual([]); });
const validation = (editor: Locator): Locator => editor.getByRole("region", { name: "server validation" }).getByRole("status");
const nodeButton = (editor: Locator, kind: string, id: string): Locator => editor.getByRole("list", { name: "graph nodes" }).getByRole("button", { name: new RegExp(`^${kind} node ${id}( · entry)?$`, "u") });
const beforeUnloadBlocked = (page: Page): Promise<boolean> => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });

async function typeNodeId(page: Page, input: Locator, id: string): Promise<void> {
  await input.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(id);
  await expect(input).toHaveValue(id);
}

async function saveConfiguration(page: Page, name: string, workflow: unknown): Promise<void> {
  const configuration = page.getByRole("region", { name: "configuration" });
  const saved = page.getByRole("combobox", { name: "saved configuration" });
  await saved.selectOption("");
  await configuration.getByLabel("name", { exact: true }).fill(name);
  await configuration.getByLabel("validated JSON fallback").fill(JSON.stringify({ verification: {}, workflow, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} }));
  await configuration.getByLabel("validated JSON fallback").blur();
  await configuration.getByRole("button", { name: "save", exact: true }).click();
  await expect(saved.locator("option:checked")).toHaveText(name);
}

test.describe("workflow canvas editing", () => {
  test("edit, undo and redo from controls and shortcuts, guarded by unsaved-changes checks", async ({ page }, testInfo) => {
    const editor = await openEditor(page);
    const dirty = editor.locator(".editor-dirty");
    await expect(dirty).toHaveText("no unsaved changes · not saved as a version");
    expect(await beforeUnloadBlocked(page)).toBe(false);
    await editor.getByRole("button", { name: "add human node" }).click();
    await expect(nodeButton(editor, "human", "human")).toBeVisible();
    await expect(dirty).toHaveText("unsaved changes");
    await editor.getByRole("button", { name: "undo" }).click();
    await expect(nodeButton(editor, "human", "human")).toHaveCount(0);
    await expect(dirty).toHaveText("no unsaved changes · not saved as a version");
    await editor.getByRole("button", { name: "redo" }).click();
    await expect(nodeButton(editor, "human", "human")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(nodeButton(editor, "human", "human")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(nodeButton(editor, "human", "human")).toBeVisible();
    await editor.getByRole("button", { name: "remove edge verification to planner" }).click();
    await expect(editor.getByRole("list", { name: "graph edges" })).not.toContainText("verification → planner");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor.getByRole("list", { name: "graph edges" })).toContainText("verification → planner");
    await page.keyboard.press("ControlOrMeta+y");
    await expect(editor.getByRole("list", { name: "graph edges" })).not.toContainText("verification → planner");
    await expect(dirty).toHaveText("unsaved changes");

    // Unsaved changes: the browser asks before unloading, and every in-app exit asks first.
    expect(await beforeUnloadBlocked(page)).toBe(true);
    await viewTab(page, "issue board").click();
    const guard = page.getByRole("alertdialog", { name: "unsaved graph changes" });
    await expect(guard).toBeVisible();
    await expect(guard.getByRole("button", { name: "keep editing" })).toBeFocused();
    await shot(page, testInfo, "editor-01-unsaved-guard");
    await page.keyboard.press("Escape");
    await expect(guard).toHaveCount(0);
    await expect(editor).toBeVisible();
    await page.getByRole("button", { name: "run view · read only" }).click();
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "keep editing" }).click();
    await expect(editor).toBeVisible();
    await expect(nodeButton(editor, "human", "human")).toBeVisible();
    await shot(page, testInfo, "editor-02-edited");
    await viewTab(page, "issue board").click();
    await guard.getByRole("button", { name: "discard changes" }).click();
    await expect(page.getByRole("region", { name: "issue board" })).toBeVisible();
    expect(await beforeUnloadBlocked(page)).toBe(false);
  });

  test("keyboard-only editing; the server rejects invalid edges, unbounded loops, missing roles and unauthorized changes", async ({ page, request }, testInfo) => {
    const project = testInfo.project.name;
    const editor = await openEditor(page);
    // Validation checks model roles and checkpoint policy against the selected configuration.
    await saveConfiguration(page, `keyboard-${project}`, { checkpoints: { mode: "interactive" } });
    await expect(validation(editor)).toContainText("checked against configuration");

    await editor.getByLabel("graph id").focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`keyboard-${project}`);
    await expect(editor.getByRole("heading", { name: `workflow graph · editing keyboard-${project}` })).toBeVisible();
    await expect(validation(editor)).toContainText("valid · version");

    // Tab order reaches the add-node controls from the graph ID, through the canvas. WebKit on
    // macOS moves focus to buttons only with Option+Tab (the platform's full keyboard access).
    const next = project === "webkit" ? "Alt+Tab" : "Tab";
    let reached = false;
    for (let step = 0; step < 80 && !reached; step += 1) {
      await page.keyboard.press(next);
      reached = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "add deterministic node");
    }
    expect(reached).toBe(true);
    for (let step = 0; step < 4; step += 1) await page.keyboard.press(next);
    await expect(editor.getByRole("button", { name: "add human node" })).toBeFocused();
    await page.keyboard.press("Enter");
    await editor.getByLabel("node id").focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("signoff");
    await page.keyboard.press("Enter");
    await expect(nodeButton(editor, "human", "signoff")).toBeVisible();
    await editor.getByLabel("checkpoint prompt").focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`Plan the accepted issues? ${UNTRUSTED}`);
    await editor.getByRole("button", { name: "remove edge verification to planner" }).focus();
    await page.keyboard.press("Enter");
    await typeNodeId(page, editor.getByLabel("connect from"), "verification");
    await typeNodeId(page, editor.getByLabel("connect to"), "signoff");
    await editor.getByRole("button", { name: "connect", exact: true }).focus();
    await page.keyboard.press("Enter");
    await typeNodeId(page, editor.getByLabel("connect from"), "signoff");
    await typeNodeId(page, editor.getByLabel("connect to"), "planner");
    await editor.getByRole("button", { name: "connect", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(editor.getByRole("list", { name: "graph edges" })).toContainText("signoff → planner");
    await expect(validation(editor)).toContainText("valid · version");

    // Delete from the node list with the keyboard, then undo it.
    await editor.getByRole("button", { name: "add gate node" }).focus();
    await page.keyboard.press("Enter");
    await nodeButton(editor, "gate", "gate").focus();
    await page.keyboard.press("Delete");
    await expect(nodeButton(editor, "gate", "gate")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(nodeButton(editor, "gate", "gate")).toBeVisible();
    await nodeButton(editor, "gate", "gate").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Delete");
    await expect(nodeButton(editor, "gate", "gate")).toHaveCount(0);

    // An edge back to the entry is an invalid edge and an unbounded cycle; the save is refused.
    await typeNodeId(page, editor.getByLabel("connect from"), "planner");
    await typeNodeId(page, editor.getByLabel("connect to"), "preflight");
    await editor.getByRole("button", { name: "connect", exact: true }).focus();
    await page.keyboard.press("Enter");
    const diagnostics = editor.getByRole("list", { name: "validation diagnostics" });
    await expect(diagnostics).toContainText("EDGE_INTO_ENTRY");
    await expect(diagnostics).toContainText("UNBOUNDED_CYCLE");
    await shot(page, testInfo, "editor-03-invalid-cycle");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(editor.getByRole("alert")).toHaveText(/^save refused · WORKFLOW_GRAPH_INVALID:.*UNBOUNDED_CYCLE/u);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(diagnostics).toHaveCount(0);

    // A model node whose role the configuration does not bind.
    await editor.getByRole("button", { name: "add model node" }).focus();
    await page.keyboard.press("Enter");
    await typeNodeId(page, editor.getByLabel("connect from"), "preflight");
    await typeNodeId(page, editor.getByLabel("connect to"), "auditor-new");
    await editor.getByRole("button", { name: "connect", exact: true }).focus();
    await page.keyboard.press("Enter");
    await typeNodeId(page, editor.getByLabel("connect from"), "auditor-new");
    await typeNodeId(page, editor.getByLabel("connect to"), "consensus");
    await editor.getByRole("button", { name: "connect", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(diagnostics).toContainText("MODEL_ROLE_UNAVAILABLE");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(editor.getByRole("alert")).toHaveText("save refused · WORKFLOW_GRAPH_INVALID:MODEL_ROLE_UNAVAILABLE");
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("ControlOrMeta+z");
    await expect(nodeButton(editor, "model", "auditor-new")).toHaveCount(0);
    await expect(validation(editor)).toContainText("valid · version");
    await expectInert(page);
    expect(await accessibilityAudit(page)).toEqual([]);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(editor.getByRole("status").filter({ hasText: /^saved keyboard-/u })).toHaveText(new RegExp(`^saved keyboard-${project} @ [a-f0-9]{64}$`, "u"));
    await expect(editor.locator(".editor-dirty")).toHaveText(/^no unsaved changes · version [a-f0-9]{64}$/u);
    await shot(page, testInfo, "editor-04-keyboard-saved");

    // Unauthorized control-plane, write and shipped-preset changes are refused by the server itself.
    const templates = (await (await request.get("/workflows")).json() as { templates: { id: string; nodes: { id: string; config?: unknown }[] }[] }).templates;
    const preset = templates.find(({ id }) => id === "audit-deep");
    const unchanged = await request.post("/workflows", { data: { graph: preset } });
    expect(unchanged.status()).toBe(422);
    expect(await unchanged.json()).toMatchObject({ message: "WORKFLOW_GRAPH_INVALID:UNAUTHORIZED_CHANGE" });
    const write = await request.post("/workflows/validate", { data: { graph: { ...preset, id: `write-${project}`, nodes: preset?.nodes.map((node) => node.id === "planner" ? { ...node, config: { writeAuthority: "repository" } } : node) } } });
    expect(await write.json()).toMatchObject({ valid: false, privileged: [{ category: "write_authority" }] });
  });

  test("a saved edited graph is the graph that executes and resumes", async ({ page, request }, testInfo) => {
    const project = testInfo.project.name;
    const graphId = `run-${project}`;
    const editor = await openEditor(page);
    await editor.getByLabel("graph id").fill(graphId);
    await editor.getByRole("button", { name: "add human node" }).click();
    await editor.getByLabel("node id").fill("signoff");
    await editor.getByLabel("node id").press("Enter");
    await editor.getByLabel("checkpoint prompt").fill(`Plan the accepted issues? ${UNTRUSTED}`);
    await editor.getByRole("button", { name: "remove edge verification to planner" }).click();
    await editor.getByLabel("connect from").fill("verification");
    await editor.getByLabel("connect to").fill("signoff");
    await editor.getByRole("button", { name: "connect", exact: true }).click();
    await editor.getByLabel("connect from").fill("signoff");
    await editor.getByLabel("connect to").fill("planner");
    await editor.getByRole("button", { name: "connect", exact: true }).click();
    await expect(validation(editor)).toContainText("valid · version");
    await editor.getByRole("button", { name: "save as new version" }).click();
    const reference = JSON.parse(await editor.getByLabel("run configuration reference").innerText()) as { graph: { id: string; version: string } };
    expect(reference.graph.id).toBe(graphId);
    const { version } = reference.graph;
    const record = await (await request.get(`/workflows/${graphId}/versions/${version}`)).json() as { graph: { nodes: { id: string }[] } };
    expect(record.graph.nodes.map(({ id }) => id)).toContain("signoff");

    await saveConfiguration(page, `run-${project}`, { ...reference, checkpoints: { mode: "interactive" } });
    const { repository } = await (await request.post("/__fixture/repositories/audit")).json() as { repository: string };
    await page.getByRole("button", { name: "run view · read only" }).click();
    const controls = page.getByRole("region", { name: "run controls" });
    await controls.getByLabel("repository").fill(repository);
    await controls.getByRole("button", { name: "start" }).click();
    await expect(controls.getByText(/^run \S+ · BLOCKED · resumable$/u)).toBeVisible();
    const runId = /^run (\S+) ·/u.exec(await controls.getByText(/^run \S+ · BLOCKED/u).innerText())?.[1] ?? "";
    const identity = page.getByLabel("executed graph identity");
    await expect(identity).toHaveText(`executes ${graphId} @ ${version} · executed graph matches the saved version`);
    await expect(page.getByRole("list", { name: "live run stages" })).toContainText("◫ human · New human");
    await expect(controls.locator(".checkpoint")).toContainText("signoff · Plan the accepted issues? <img src=x");
    await expectInert(page);
    await shot(page, testInfo, "editor-05-saved-graph-blocked");

    // A later version of the same graph must not change what this run resumes.
    const later = await request.post("/workflows", { data: { graph: { ...record.graph, nodes: record.graph.nodes.map((node) => node.id === "signoff" ? { ...node, label: "Later sign-off" } : node) }, parentVersion: version } });
    expect(later.status()).toBe(200);
    const laterVersion = (await later.json() as { record: { version: string } }).record.version;
    expect(laterVersion).not.toBe(version);

    await controls.locator(".checkpoint").getByRole("button", { name: "approve" }).click();
    await expect(controls.locator(".checkpoint")).toHaveCount(0);
    await controls.getByRole("button", { name: "resume" }).click();
    await expect(controls.getByText(`run ${runId} · COMPLETED · not resumable`)).toBeVisible();
    const status = await (await request.get(`/runs/${runId}`)).json() as { state: string; workflowGraph: unknown; workflow: unknown };
    expect(status).toMatchObject({ state: "COMPLETED", workflowGraph: { id: graphId, version, executedVersion: version }, workflow: record.graph });
    await page.goto(`/?run=${encodeURIComponent(runId)}&view=graph`);
    await expect(page.getByLabel("executed graph identity")).toHaveText(`executes ${graphId} @ ${version} · executed graph matches the saved version`);
    await expect(page.getByRole("list", { name: "live run stages" })).toContainText("◫ human · New human");
    await viewTab(page, "issue board").click();
    await expect(page.getByRole("region", { name: "issue board" }).getByText(/^\d+ of \d+ canonical issues shown$/u)).toBeVisible();
    await viewTab(page, "workflow graph").click();
    await shot(page, testInfo, "editor-06-saved-graph-completed");
  });
});
