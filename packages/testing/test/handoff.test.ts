import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { freshExecutor, runAuditAcceptance, runRealHandoff, writeRenderedTree, type FakeModels } from "../src/fresh-executor.js";

const fixtureRoot = new URL("../fixtures/handoff/", import.meta.url);
const contract = readJson<{ readonly fixtureId: string }>("audit-contract.json");
const fakeModels: FakeModels = { responses: readJson<Record<string, unknown>>("fake-models.json") };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fresh executor isolation", () => {
  it("generates the handoff from the Audit fixture and verifies the scripted isolation harness", async () => {
    const generated = await generatedInputs();
    const sourceBefore = readFileSync(join(generated.repository, "src", "add.js"), "utf8");
    const result = freshExecutor(generated.repository, generated.implementation);

    expect(result).toMatchObject({ isolationPassed: true, handoffAccepted: false, executorExitCode: 0, verificationExitCode: 0, immutableContractsPreserved: true });
    expect(result.transcript).toContain("scripted isolation executor");
    expect(readFileSync(join(generated.repository, "src", "add.js"), "utf8")).toBe(sourceBefore);
  });

  it("fails when a required implementation section is removed", async () => {
    const generated = await generatedInputs();
    unlinkSync(join(generated.implementation, "AGENTS.md"));

    expect(() => freshExecutor(generated.repository, generated.implementation)).toThrow("HANDOFF_REQUIRED_SECTION_MISSING:AGENTS.md");
  });

  it("fails when any extra context is supplied", async () => {
    const generated = await generatedInputs();

    expect(() => freshExecutor(generated.repository, generated.implementation, ["hidden-run-context"])).toThrow("FRESH_EXECUTOR_EXTRA_CONTEXT_FORBIDDEN");
  });

  it("rejects run or journal context before constructing the isolated workspace", async () => {
    const generated = await generatedInputs();
    mkdirSync(join(generated.repository, ".runs"));
    writeFileSync(join(generated.repository, ".runs", "hidden.json"), "{}\n", "utf8");

    expect(() => freshExecutor(generated.repository, generated.implementation)).toThrow("FRESH_EXECUTOR_RUN_CONTEXT_FORBIDDEN:.runs");
  });

  it("accepts from deterministic verification rather than the external executor exit status", async () => {
    const generated = await generatedInputs();
    const scriptedRepair = '(console.log(process.env.NPM_TOKEN??"NO_NPM_TOKEN"),require("node:fs").writeFileSync("repository/src/add.js","export function add(left, right) {\\n  return left + right\\n}\\n"),process.exitCode=7)';
    const previousToken = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = "must-not-reach-fresh-agent";
    let result;
    try { result = runRealHandoff(`${quote(process.execPath)} -e ${quote(scriptedRepair)}`, generated.repository, generated.implementation); }
    finally { if (previousToken === undefined) delete process.env.NPM_TOKEN; else process.env.NPM_TOKEN = previousToken; }

    expect(result).toMatchObject({ handoffAccepted: true, executorExitCode: 7, verificationExitCode: 0, immutableContractsPreserved: true });
    expect(result.transcript).toContain("NO_NPM_TOKEN");
    expect(result.transcript).not.toContain("must-not-reach-fresh-agent");
  });

  it("does not import run persistence or journal modules", () => {
    const source = readFileSync(new URL("../src/fresh-executor.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/from\s+["'][^"']*(?:\.runs|journal|run-persistence)[^"']*["']/iu);
  });
});

async function generatedInputs(): Promise<{ repository: string; implementation: string }> {
  const root = mkdtempSync(join(tmpdir(), "arbitra-generated-handoff-"));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const implementation = join(root, "implementation");
  cpSync(fileURLToPath(new URL("repository/", fixtureRoot)), repository, { recursive: true });
  const result = await runAuditAcceptance({ fixtureId: contract.fixtureId, repositoryDir: repository }, fakeModels);
  writeRenderedTree(result.implementationTree, implementation);
  return { repository, implementation };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, fixtureRoot), "utf8")) as T;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "")}'`;
}
