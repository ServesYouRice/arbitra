import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { orchestratorCore } from "@arbitra/runtime/cli-core.js";
import { runCli } from "../src/main.js";
import { parseWorkflowCommand } from "../src/commands/workflow.js";

const io = { writeStdout: () => undefined, writeStderr: () => undefined };

it("lists, validates, saves and shows operator-authored graphs through the orchestrator", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-cli-"));
  const cli = () => orchestratorCore(new Orchestrator({ repository: root, now: () => "2026-02-01T00:00:00.000Z" }));
  try {
    expect(() => parseWorkflowCommand(["save", "a.json", "--everything"])).toThrow("USAGE");
    expect(() => parseWorkflowCommand(["validate", "a.json", "--parent=abc"])).toThrow("USAGE");
    const listed = await runCli(["workflow", "list", "--json"], cli(), io);
    expect(listed.exit).toBe(0);
    const template = (listed.output.result as { templates: { id: string }[] }).templates.find(({ id }) => id === "audit-balanced");
    const presetPath = join(root, "preset.json");
    await writeFile(presetPath, JSON.stringify(template));
    // A shipped preset ID is privileged: refused by default, accepted only when named.
    const refused = await runCli(["workflow", "save", presetPath, "--json"], cli(), io);
    expect(refused.exit).toBe(1);
    expect(refused.output.policy.reasons).toEqual(["UNAUTHORIZED_CHANGE"]);
    const renamedPath = join(root, "renamed.json");
    await writeFile(renamedPath, JSON.stringify({ ...template, id: "cli-balanced" }));
    expect((await runCli(["workflow", "validate", renamedPath, "--json"], cli(), io)).exit).toBe(0);
    const saved = await runCli(["workflow", "save", renamedPath, "--json"], cli(), io);
    expect(saved.exit).toBe(0);
    const { record } = saved.output.result as { record: { version: string; authorizations: string[] } };
    const authorized = await runCli(["workflow", "save", presetPath, "--authorize=shipped_preset_id", "--json"], cli(), io);
    expect(authorized.exit).toBe(0);
    expect((authorized.output.result as { record: { authorizations: string[] } }).record.authorizations).toEqual(["shipped_preset_id"]);
    const shown = await runCli(["workflow", "show", "cli-balanced", record.version, "--json"], cli(), io);
    expect(shown.output.result).toMatchObject({ graphId: "cli-balanced", version: record.version, savedAt: "2026-02-01T00:00:00.000Z" });
    expect((await runCli(["workflow", "show", "cli-balanced", "--json"], cli(), io)).output.result).toMatchObject({ versions: [{ version: record.version }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
