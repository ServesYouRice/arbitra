#!/usr/bin/env node
// Searches a finished audit run's confirmed issues for variants, and verifies what the search proposes, without running
// the rest of the audit again, so the variant search (workflow.variantSearch) can be measured on runs already done.
//   node tooling/variant-replay/replay.mjs <stored run directory> <output directory>
//     [--searcher <profile> | --searcher-copy <profile>:<model id>] [--effort <level>] [--config <file>] [--repository <checkout>]
//
// The stored run is only read. A new run store under <output directory> receives copies of the stages the search reads
// (the verified issue set, its source findings, the verification results and the pinned protocols); the search and the
// verification of its proposals are recorded there as in a run (variant-search, variant-search-batch-*,
// variant-search-duplicates, variant-verification-*, and the issue set with the confirmed variants added). --searcher
// names a profile of the run's configuration; --searcher-copy adds one, a copy of the named profile with another model
// (claude-sonnet-5-5 on a Claude Code profile, say). --config replaces the run's model configuration. --repository reads
// a checkout of the run's commit when the repository has moved on: the files the run read must still match. This makes
// real model calls through the configuration's endpoints; its subscription CLIs must be signed in on this host.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [source, output, ...rest] = process.argv.slice(2);
const usage = "usage: replay.mjs <stored run directory> <output directory> [--searcher <profile> | --searcher-copy <profile>:<model id>] [--effort <level>] [--config <file>] [--repository <checkout>]\n";
if (source === undefined || output === undefined) { process.stderr.write(usage); process.exit(2); }
const option = (name) => { const index = rest.indexOf(name); return index < 0 ? undefined : rest[index + 1]; };
const known = new Set(["--searcher", "--searcher-copy", "--effort", "--config", "--repository"]);
for (let index = 0; index < rest.length; index += 2) if (!known.has(rest[index] ?? "") || rest[index + 1] === undefined) { process.stderr.write(usage); process.exit(2); }
const copy = option("--searcher-copy");
const [copyOf, modelId] = copy === undefined ? [] : [copy.slice(0, copy.indexOf(":")), copy.slice(copy.indexOf(":") + 1)];
if (copy !== undefined && (copyOf === "" || modelId === "" || !copy.includes(":"))) { process.stderr.write(usage); process.exit(2); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { replayVariantSearch } = await import(pathToFileURL(join(root, "packages/runtime/dist/src/variant-replay.js")).href);

const configPath = option("--config");
const started = Date.now();
const replay = await replayVariantSearch({
  source: resolve(source), output: resolve(output),
  ...(option("--searcher") === undefined ? {} : { searcher: option("--searcher") }),
  ...(copy === undefined ? {} : { searcherProfile: { copyOf, modelId } }),
  ...(option("--effort") === undefined ? {} : { effort: option("--effort") }),
  ...(configPath === undefined ? {} : { configuration: JSON.parse(readFileSync(configPath, "utf8")) }),
  ...(option("--repository") === undefined ? {} : { repository: resolve(option("--repository")) }),
  providerOptions: { credential: (name) => process.env[name] },
});
const minutes = (Date.now() - started) / 60_000;
// What the replay spent, from its own traces: the search's calls and the verification of what it proposed.
const index = JSON.parse(readFileSync(join(replay.directory, "artifacts.json"), "utf8"));
const traces = index.filter(({ kind }) => /^model-activity-[0-9a-f]+-trace$/u.test(kind)).map(({ ref }) => JSON.parse(readFileSync(join(replay.directory, ref.relativePath), "utf8")));
const usage = traces.flatMap(({ activityId, attempts }) => attempts.map((attempt) => ({ stage: String(activityId).startsWith("variant-search/") ? "search" : "verification", usage: attempt.usage })))
  .reduce((sum, { stage, usage: used }) => ({ ...sum, [stage]: { calls: (sum[stage]?.calls ?? 0) + 1, input: (sum[stage]?.input ?? 0) + (used?.inputTokens ?? 0), output: (sum[stage]?.output ?? 0) + (used?.outputTokens ?? 0), cacheRead: (sum[stage]?.cacheRead ?? 0) + (used?.cacheReadTokens ?? 0) } }), {});
const summary = { runId: replay.runId, minutes: Math.round(minutes * 10) / 10, ...replay.summary, usage };
writeFileSync(join(resolve(output), `${replay.runId}-summary.json`), JSON.stringify(summary, null, 1));
process.stdout.write(`${JSON.stringify(summary)}\n`);
