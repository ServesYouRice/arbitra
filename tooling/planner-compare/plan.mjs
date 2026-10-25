#!/usr/bin/env node
// Plans the accepted issues of a stored audit run again, so two planners can be compared on the same issues.
//   node tooling/planner-compare/plan.mjs <stored run directory> <output directory> <whole|sections> [issuesPerSection=13]
//     [--limits <contextTokens>:<maxOutputTokens>]
//
// The stored run is only read. A new run store under <output directory> receives copies of the stages the planner
// reads (source findings, unresolved peer operations) and the planner's own activities; nothing is written to the
// stored run. "whole" is the planner as it was (one call while the plan fits, else notes, an outline and one call a
// task); "sections" writes the plan in sections of related issues side by side (`modelExecution.planSections`).
// `--limits` replaces the planner profile's context and output limits (and the run's output ceiling, when larger),
// so a run stored under one protocol can be planned under another's. This makes real model calls through the stored
// run's model configuration; its subscription CLIs must be signed in on this host.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [source, output, variant, perSectionText = "13", ...rest] = process.argv.slice(2);
if (source === undefined || output === undefined || !["whole", "sections"].includes(variant ?? "")) {
  process.stderr.write("usage: plan.mjs <stored run directory> <output directory> <whole|sections> [issuesPerSection] [--limits <contextTokens>:<maxOutputTokens>]\n"); process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { RunStore } = await load("packages/runtime/dist/src/run-store.js");
const { SNAPSHOT_FILE_LIMIT, snapshotRepository } = await load("packages/runtime/dist/src/repository.js");
const { ModelAuditPipeline } = await load("packages/runtime/dist/src/model-pipeline.js");

const context = JSON.parse(readFileSync(join(source, "context.json"), "utf8"));
const list = JSON.parse(readFileSync(join(source, "artifacts.json"), "utf8"));
const stage = (kind) => { const found = list.filter((entry) => entry.kind === kind).at(-1); if (found === undefined) throw new Error(`STAGE_ABSENT:${kind}`); return JSON.parse(readFileSync(join(source, found.ref.relativePath), "utf8")); };
const config = structuredClone(context.modelConfiguration);
const execution = config.workflow.modelExecution;
const planner = execution.roles.planner;
const limits = rest[0] === "--limits" ? rest[1]?.split(":").map(Number) : undefined;
if (limits !== undefined) {
  const [contextTokens, maxOutputTokens] = limits;
  config.models[planner] = { ...config.models[planner], limits: { ...config.models[planner].limits, contextTokens, maxOutputTokens } };
  execution.maximumOutputTokens = Math.max(execution.maximumOutputTokens, maxOutputTokens);
}
if (variant === "sections") execution.planSections = { issuesPerSection: Number(perSectionText) }; else delete execution.planSections;

const runId = `run-${randomUUID()}`;
mkdirSync(output, { recursive: true });
const store = new RunStore(output, runId);
await store.saveContext({ ...context, criticEnabled: false, modelConfiguration: config });
for (const kind of ["source-findings", "peer-operation-conflicts"]) await store.publish(kind, stage(kind));
const issues = stage("canonical-issues");
const snapshot = await snapshotRepository(context.repository, SNAPSHOT_FILE_LIMIT, { scope: context.scope });
const auditors = Object.keys(config.models).filter((id) => id.startsWith("auditor-")).map((auditorId) => ({ auditorId, independenceGroup: config.models[auditorId].independenceGroup, ruleIds: [] }));
const pipeline = new ModelAuditPipeline({ snapshot, store, auditors, auditorKind: "model_auditors", policy: { name: context.consensusPolicy, quorum: 2, minimumIndependentGroupsForHighRisk: 2 }, maximumRounds: context.maximumRounds, criticEnabled: false },
  config, { credential: (name) => process.env[name], liveDispatch: true });

const started = Date.now();
const plan = await pipeline.plan(issues, new AbortController().signal);
const minutes = (Date.now() - started) / 60_000;
const index = JSON.parse(readFileSync(join(output, runId, "artifacts.json"), "utf8"));
const traces = index.filter(({ kind }) => /^model-activity-[0-9a-f]+-trace$/u.test(kind)).map(({ ref }) => JSON.parse(readFileSync(join(output, runId, ref.relativePath), "utf8")));
const usage = traces.flatMap(({ attempts }) => attempts).reduce((sum, { usage: used }) => ({ calls: sum.calls + 1, input: sum.input + (used?.inputTokens ?? 0), output: sum.output + (used?.outputTokens ?? 0), cacheRead: sum.cacheRead + (used?.cacheReadTokens ?? 0) }), { calls: 0, input: 0, output: 0, cacheRead: 0 });
const summary = { variant, runId, issues: plan.acceptedIssueIds.length, tasks: plan.tasks.length, minutes: Math.round(minutes * 10) / 10, ...usage, characters: JSON.stringify(plan).length };
writeFileSync(join(output, `${variant}-plan.json`), JSON.stringify(plan, null, 1));
writeFileSync(join(output, `${variant}-summary.json`), JSON.stringify(summary, null, 1));
process.stdout.write(`${JSON.stringify(summary)}\n`);
