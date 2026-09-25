#!/usr/bin/env node
/**
 * P06 premise evaluation.
 *
 *   node packages/testing/dist/src/premise-evaluation/cli.js run     --protocol docs/qa/p06/protocol.json [--state .runs/p06] [--evidence docs/qa/p06/evidence] [--max-runs N]
 *   node packages/testing/dist/src/premise-evaluation/cli.js analyse --protocol docs/qa/p06/protocol.json [--evidence docs/qa/p06/evidence]
 *
 * `run` executes (or resumes) the prespecified schedule through the public Orchestrator.
 * Credentials come only from the environment variables the configuration names.
 * `analyse` scores every saved run, writes results.json and imports the observations into
 * the durable evaluation corpus under <evidence>/corpus.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { redactSecrets } from "@arbitra/security/redaction";

import { analyse, type EvaluationRecord } from "./analysis.js";
import { corpusImport, persistCorpus } from "./corpus.js";
import { executeProtocol } from "./driver.js";
import { loadGroundTruth, loadProtocol } from "./protocol.js";

const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
for (let index = 0; index < rest.length; index += 2) flags.set(rest[index] ?? "", rest[index + 1] ?? "");
const root = resolve(flags.get("--root") ?? process.cwd());
const protocolPath = flags.get("--protocol");
if ((command !== "run" && command !== "analyse") || protocolPath === undefined) {
  process.stderr.write("usage: cli.js run|analyse --protocol <protocol.json> [--root <repository>] [--state <dir>] [--evidence <dir>] [--max-runs N]\n");
  process.exit(2);
}
const protocol = loadProtocol(resolve(root, protocolPath));
const evidence = resolve(root, flags.get("--evidence") ?? "docs/qa/p06/evidence");
const log = (line: string): void => { process.stderr.write(`${new Date().toISOString()} ${line}\n`); };

if (command === "run") {
  const maximum = flags.get("--max-runs");
  const result = await executeProtocol({ root, protocol, stateRoot: resolve(root, flags.get("--state") ?? ".runs/p06"), evidenceDirectory: evidence, log, ...(maximum === undefined ? {} : { maximumRunsThisInvocation: Number(maximum) }) });
  process.stdout.write(`${JSON.stringify({ completedThisInvocation: result.completed, stoppedReason: result.stoppedReason, budget: result.budget, runs: Object.values(result.ledger.runs).map(({ key, runId, status, state, failures, segments }) => ({ key, runId, status, state, failures, segments: segments.length })) }, null, 2)}\n`);
} else {
  const truths = new Map(protocol.fixtures.map((fixture) => [fixture.id, loadGroundTruth(root, fixture)]));
  const runs = join(evidence, "runs");
  const records = readdirSync(runs).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(readFileSync(join(runs, name), "utf8")) as EvaluationRecord & { readonly protocolId: string; readonly protocolVersion: string })
    .filter((record) => record.protocolId === protocol.protocolId && record.protocolVersion === protocol.version);
  const report = analyse(protocol, truths, records, "real_models");
  const corpus = await persistCorpus(join(evidence, "corpus"), corpusImport(protocol, truths, records, "real_models", "2026-09-25T00:00:00Z"), Date.now);
  const output = { ...report, corpus: { appended: corpus.appended, unchanged: corpus.unchanged, independenceReport: corpus.independenceReport.ref, outcomeReport: corpus.outcomeReport.ref, independenceSummary: corpus.independenceReport.report.summary, outcomeSummary: corpus.outcomeReport.report.summary } };
  const text = JSON.stringify(output, null, 2);
  const redacted = redactSecrets(text);
  if (redacted.redactions.length > 0) log(`redacted ${redacted.redactions.length} secret-shaped strings from results`);
  writeFileSync(join(evidence, "results.json"), `${redacted.text}\n`);
  log(`wrote ${join(evidence, "results.json")}`);
  process.stdout.write(`${JSON.stringify({ decision: report.decision, conditions: report.conditions.map(({ condition, instances, recall, precision }) => ({ condition, instances, recall, precision })), missingRuns: report.missingRuns }, null, 2)}\n`);
}
