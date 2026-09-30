#!/usr/bin/env node
/**
 * P06 premise evaluation.
 *
 *   node packages/testing/dist/src/premise-evaluation/cli.js run     --protocol docs/qa/p06/protocol.json [--state .runs/p06] [--evidence docs/qa/p06/evidence] [--max-runs N]
 *   node packages/testing/dist/src/premise-evaluation/cli.js abandon --protocol docs/qa/p06/protocol.json --key <fixture/condition/rN> --reason <text>
 *   node packages/testing/dist/src/premise-evaluation/cli.js analyse --protocol docs/qa/p06/protocol.json [--evidence docs/qa/p06/evidence]
 *   node packages/testing/dist/src/premise-evaluation/cli.js compare --lineups docs/qa/p20/lineups.json
 *
 * `run` executes (or resumes) the prespecified schedule through the public Orchestrator.
 * Credentials come only from the environment variables the configuration names.
 * `analyse` scores every saved run, writes results.json and imports the observations into
 * the durable evaluation corpus under <evidence>/corpus. `compare` analyses each lineup's protocol
 * from its saved runs and writes the prespecified cross-lineup comparisons (P20).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { redactSecrets } from "@arbitra/security/redaction";

import { analyse, type EvaluationRecord } from "./analysis.js";
import { corpusImport, persistCorpus } from "./corpus.js";
import { abandonRun, executeProtocol, readConfiguration } from "./driver.js";
import { assertSameFixtures, compareLineups, loadLineupPlan } from "./lineups.js";
import { loadGroundTruth, loadProtocol, type EvaluationProtocol } from "./protocol.js";

const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
for (let index = 0; index < rest.length; index += 2) flags.set(rest[index] ?? "", rest[index + 1] ?? "");
const root = resolve(flags.get("--root") ?? process.cwd());
const log = (line: string): void => { process.stderr.write(`${new Date().toISOString()} ${line}\n`); };
const savedRecords = (protocol: EvaluationProtocol, evidence: string) => readdirSync(join(evidence, "runs")).filter((name) => name.endsWith(".json")).sort()
  .map((name) => JSON.parse(readFileSync(join(evidence, "runs", name), "utf8")) as Omit<EvaluationRecord, "record"> & { readonly record: EvaluationRecord["record"] | null; readonly protocolId: string; readonly protocolVersion: string })
  .filter((record) => record.protocolId === protocol.protocolId && record.protocolVersion === protocol.version);
// Distinct model families of the heterogeneous configuration decide how a report states the premise it tests.
const familiesOf = (protocol: EvaluationProtocol) => [...new Set(Object.values(readConfiguration(root, protocol).models).map(({ family }) => family))].sort();

if (command === "compare") {
  const planPath = flags.get("--lineups");
  if (planPath === undefined) { process.stderr.write("usage: cli.js compare --lineups <lineups.json> [--root <repository>]\n"); process.exit(2); }
  const plan = loadLineupPlan(root, planPath);
  const protocols = Object.fromEntries(Object.entries(plan.lineups).map(([lineup, { protocol }]) => [lineup, loadProtocol(resolve(root, protocol))]));
  assertSameFixtures(protocols);
  const first = Object.values(protocols)[0];
  if (first === undefined) throw new Error("P20_LINEUPS_ABSENT");
  const truths = new Map(first.fixtures.map((fixture) => [fixture.id, loadGroundTruth(root, fixture)]));
  const reports = Object.fromEntries(Object.entries(plan.lineups).map(([lineup, { evidence }]) => {
    const protocol = protocols[lineup];
    if (protocol === undefined) throw new Error(`P20_LINEUP_PROTOCOL_ABSENT:${lineup}`);
    return [lineup, analyse(protocol, truths, savedRecords(protocol, resolve(root, evidence)), "real_models", familiesOf(protocol))];
  }));
  const report = compareLineups(plan, reports, truths);
  writeFileSync(resolve(root, plan.output), `${redactSecrets(JSON.stringify(report, null, 2)).text}\n`);
  log(`wrote ${resolve(root, plan.output)}`);
  process.stdout.write(`${JSON.stringify(report.comparisons.map(({ name, recallDifference, verdict }) => ({ name, recallDifference, verdict })), null, 2)}\n`);
  process.exit(0);
}
const protocolPath = flags.get("--protocol");
if ((command !== "run" && command !== "analyse" && command !== "abandon") || protocolPath === undefined) {
  process.stderr.write("usage: cli.js run|analyse|abandon --protocol <protocol.json> [--root <repository>] [--state <dir>] [--evidence <dir>] [--max-runs N], or cli.js compare --lineups <lineups.json>\n");
  process.exit(2);
}
const protocol = loadProtocol(resolve(root, protocolPath));
const evidence = resolve(root, flags.get("--evidence") ?? "docs/qa/p06/evidence");

if (command === "run") {
  const maximum = flags.get("--max-runs");
  const result = await executeProtocol({ root, protocol, stateRoot: resolve(root, flags.get("--state") ?? ".runs/p06"), evidenceDirectory: evidence, log, ...(maximum === undefined ? {} : { maximumRunsThisInvocation: Number(maximum) }) });
  process.stdout.write(`${JSON.stringify({ completedThisInvocation: result.completed, stoppedReason: result.stoppedReason, budget: result.budget, runs: Object.values(result.ledger.runs).map(({ key, runId, status, state, failures, segments }) => ({ key, runId, status, state, failures, segments: segments.length })) }, null, 2)}\n`);
} else if (command === "abandon") {
  const key = flags.get("--key"); const reason = flags.get("--reason");
  if (key === undefined || reason === undefined) throw new Error("P06_ABANDON_USAGE: --key <fixture/condition/rN> --reason <text>");
  const entry = await abandonRun({ root, protocol, stateRoot: resolve(root, flags.get("--state") ?? ".runs/p06"), evidenceDirectory: evidence }, key, reason);
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
} else {
  const truths = new Map(protocol.fixtures.map((fixture) => [fixture.id, loadGroundTruth(root, fixture)]));
  const records = savedRecords(protocol, evidence);
  const report = analyse(protocol, truths, records, "real_models", familiesOf(protocol));
  const corpus = await persistCorpus(join(evidence, "corpus"), corpusImport(protocol, truths, records.filter((item): item is typeof item & EvaluationRecord => item.record !== null), "real_models", "2026-09-25T00:00:00Z"), Date.now);
  const output = { ...report, corpus: { appended: corpus.appended, unchanged: corpus.unchanged, independenceReport: corpus.independenceReport.ref, outcomeReport: corpus.outcomeReport.ref, independenceSummary: corpus.independenceReport.report.summary, outcomeSummary: corpus.outcomeReport.report.summary } };
  const text = JSON.stringify(output, null, 2);
  const redacted = redactSecrets(text);
  if (redacted.redactions.length > 0) log(`redacted ${redacted.redactions.length} secret-shaped strings from results`);
  writeFileSync(join(evidence, "results.json"), `${redacted.text}\n`);
  log(`wrote ${join(evidence, "results.json")}`);
  process.stdout.write(`${JSON.stringify({ decision: report.decision, conditions: report.conditions.map(({ condition, instances, recall, precision }) => ({ condition, instances, recall, precision })), missingRuns: report.missingRuns }, null, 2)}\n`);
}
