import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const executorCommand = process.env.ARBITRA_HANDOFF_EXECUTOR?.trim();
if (executorCommand === undefined || executorCommand === "") {
  process.stderr.write("ARBITRA_HANDOFF_EXECUTOR must name the explicitly approved fresh coding-agent command.\n");
  process.exitCode = 2;
} else {
  process.env.ARBITRA_HANDOFF_USE_DIST = "1";
  const { runAuditAcceptance, runRealHandoff, writeRenderedTree } = await import("../src/fresh-executor.ts");
  const fixtureRoot = new URL("../fixtures/handoff/", import.meta.url);
  const contract = JSON.parse(readFileSync(new URL("audit-contract.json", fixtureRoot), "utf8")) as { readonly fixtureId: string };
  const responses = JSON.parse(readFileSync(new URL("fake-models.json", fixtureRoot), "utf8")) as Record<string, unknown>;
  const temporaryRoot = mkdtempSync(join(tmpdir(), "arbitra-real-handoff-inputs-"));
  const repository = join(temporaryRoot, "repository");
  const implementation = join(temporaryRoot, "implementation");

  try {
    cpSync(fileURLToPath(new URL("repository/", fixtureRoot)), repository, { recursive: true });
    const audit = await runAuditAcceptance({ fixtureId: contract.fixtureId, repositoryDir: repository }, { responses });
    writeRenderedTree(audit.implementationTree, implementation);
    const result = runRealHandoff(executorCommand, repository, implementation);
    process.stdout.write(`${JSON.stringify({
      fixtureId: contract.fixtureId,
      isolationPassed: result.isolationPassed,
      handoffAccepted: result.handoffAccepted,
      executorExitCode: result.executorExitCode,
      verificationExitCode: result.verificationExitCode,
      immutableContractsPreserved: result.immutableContractsPreserved,
    }, null, 2)}\n\n${result.transcript}\n`);
    process.exitCode = result.handoffAccepted ? 0 : 1;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
