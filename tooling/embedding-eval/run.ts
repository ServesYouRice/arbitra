/**
 * P18 runner (docs/qa/p18/PROTOCOL.md). `pnpm fetch-model` downloads and hash-verifies the pinned model into
 * ./.cache; `pnpm eval [--corpus <file>] [--out <file>]` evaluates offline (remote loading disabled, fetch
 * blocked and counted) and writes a JSON report with identities, measurements and the prespecified decision.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cluster } from "../../packages/workflow/src/clustering/escalate.ts";
import { decideAdoption, embedFindings, embeddingPairResolver, evaluateEmbeddingClustering, loadClusteringCorpus, P18_SETTINGS, type ClusteringCorpus, type TextEmbedder } from "../../packages/workflow/src/clustering/evaluation.ts";

const MODEL = Object.freeze({ id: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9", artifact: "onnx/model.onnx", dtype: "fp32", artifactBytes: 90_387_606, artifactSha256: "759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e", dimensions: 384 });
const here = dirname(fileURLToPath(import.meta.url)); const repository = resolve(here, "../..");
const args = process.argv.slice(2); const option = (name: string) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const corpusPath = resolve(option("--corpus") ?? join(repository, "packages/testing/corpora/clustering/authored-v1.json"));

const rssSamples: number[] = []; const sampler = setInterval(() => rssSamples.push(process.memoryUsage().rss), 5); sampler.unref();
const corpusText = readFileSync(corpusPath, "utf8"); const declared = JSON.parse(corpusText) as ClusteringCorpus;
const loaded = loadClusteringCorpus(corpusText, new Map(declared.sourceFixtures.map(({ groundTruth }) => [groundTruth, readFileSync(resolve(dirname(corpusPath), groundTruth), "utf8")])));
for (const run of loaded.corpus.runs) await cluster(run.findings.map(({ auditorId, finding }) => ({ validation: "accepted" as const, auditorId, finding })));
const baselineRss = Math.max(process.memoryUsage().rss, ...rssSamples);

let networkRequests = 0; const realFetch = globalThis.fetch; const fetchOnly = args.includes("--fetch-only");
globalThis.fetch = (async (...request: Parameters<typeof fetch>) => { networkRequests += 1; if (!fetchOnly) throw new Error(`P18_NETWORK_BLOCKED:${String(request[0])}`); return realFetch(...request); }) as typeof fetch;
const transformers = await import("@huggingface/transformers");
transformers.env.cacheDir = join(here, ".cache"); transformers.env.allowRemoteModels = fetchOnly; transformers.env.allowLocalModels = false;

const coldStart = performance.now();
const extractor = await transformers.pipeline("feature-extraction", MODEL.id, { revision: MODEL.revision, dtype: MODEL.dtype, device: "cpu" });
await extractor(["warm-up"], { pooling: "mean", normalize: true });
const coldLoadMs = performance.now() - coldStart;
const artifactPath = findArtifact(join(here, ".cache")); const artifact = readFileSync(artifactPath);
if (artifact.byteLength !== MODEL.artifactBytes || createHash("sha256").update(artifact).digest("hex") !== MODEL.artifactSha256) throw new Error(`P18_MODEL_ARTIFACT_MISMATCH:${artifactPath}`);
if (fetchOnly) { process.stdout.write(`Model verified at ${relative(repository, artifactPath)} (${artifact.byteLength} bytes, sha256 ${MODEL.artifactSha256}).\n`); process.exit(0); }

const packageVersion = (name: string) => (JSON.parse(readFileSync(join(here, "node_modules/.pnpm", readdirSync(join(here, "node_modules/.pnpm")).find((entry) => entry.startsWith(`${name.replace("/", "+")}@`) && !entry.includes("-dev")) ?? "missing", "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
const runtime = `@huggingface/transformers@${packageVersion("@huggingface/transformers")} onnxruntime-node@${packageVersion("onnxruntime-node")} node@${process.versions.node} ${process.platform}-${process.arch}`;
const embedder: TextEmbedder = { identity: Object.freeze({ model: MODEL.id, revision: MODEL.revision, artifact: MODEL.artifact, artifactSha256: MODEL.artifactSha256, runtime, dtype: MODEL.dtype, pooling: "mean" as const, normalized: true as const, dimensions: MODEL.dimensions }),
  async embed(texts) { const output = await extractor([...texts], { pooling: "mean", normalize: true }); return (output.tolist() as number[][]).map((row) => Float32Array.from(row)); } };

const report = await evaluateEmbeddingClustering(loaded, { embedder, clock: () => performance.now() });
// Descriptive scaling probe (not a criterion): one synthetic run of 200 findings built by relabelling corpus findings.
const pool = loaded.corpus.runs.flatMap(({ findings }) => findings); const synthetic = Array.from({ length: 200 }, (_, index) => { const source = pool[index % pool.length]; if (source === undefined) throw new Error("P18_EMPTY_CORPUS"); return { validation: "accepted" as const, auditorId: `${source.auditorId}-${index}`, finding: { ...source.finding, sourceFindingId: `${source.finding.sourceFindingId}#${index}` } }; });
const scaleStart = performance.now(); const scaleVectors = await embedFindings(embedder, synthetic); const scaled = await cluster(synthetic, { semantic: embeddingPairResolver(scaleVectors, 0.5), maximumEscalatedPairs: P18_SETTINGS.maximumEscalatedPairs }); const scaleMs = performance.now() - scaleStart;
const peakRss = Math.max(process.memoryUsage().rss, ...rssSamples); clearInterval(sampler);
const resources = { coldLoadMs: Math.round(coldLoadMs), modelBytes: artifact.byteLength, rssGrowthBytes: peakRss - baselineRss, dependencyBytes: dependencyBytes(), networkRequests, marginalCostUsd: 0 };
const decision = decideAdoption(report, resources);
const output = { generatedAt: new Date().toISOString(), commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--", "packages", "tooling"]) !== "", host: { cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, memoryBytes: totalmem(), loadAverage: process.platform === "win32" ? null : (await import("node:os")).loadavg() }, corpusPath: relative(repository, corpusPath),
  resources: { ...resources, baselineRssBytes: baselineRss, peakRssBytes: peakRss, artifactPath: relative(here, artifactPath), coldLoadNote: "pipeline construction + one warm-up embed from the local cache; OS file cache may already hold the artifact" },
  scalingProbe: { findings: synthetic.length, embedAndClusterMs: Math.round(scaleMs), ambiguousPairs: scaled.ambiguousPairs.length, note: "descriptive only; relabelled duplicates of corpus findings" }, report, decision };
const outPath = resolve(option("--out") ?? join(repository, "docs/qa/p18/results", `${loaded.corpus.corpusId}.json`)); mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
const row = (name: string, value: typeof report.configurations.deterministic) => `${name.padEnd(22)} FM=${value.score.falseMerges} FS=${value.score.falseSplits} W=${value.score.weightedErrors} defectLoss=${value.score.defectLossMerges} candidates=${value.score.candidates} contaminated=${value.score.contaminatedCandidates} redundant=${value.score.redundantCandidates} ΔW=${value.versusDeterministic.difference} [${value.versusDeterministic.lower}, ${value.versusDeterministic.upper}]`;
process.stdout.write([`Corpus ${report.corpus.corpusId}@${report.corpus.version} (${report.corpus.mode}) sha256 ${report.corpus.sha256}`, `Embedder ${runtime} ${MODEL.id}@${MODEL.revision}`, `Thresholds E1 ${JSON.stringify(report.thresholds.e1)} E2 ${JSON.stringify(report.thresholds.e2)}`, row("D deterministic", report.configurations.deterministic), row("E1 embedding escalation", report.configurations.embeddingEscalation), row("E2 embedding only", report.configurations.embeddingOnly), row("S* oracle escalation", report.configurations.oracleEscalation), `Latency D ${JSON.stringify(report.latency.deterministic)} E1 ${JSON.stringify(report.latency.embeddingEscalation)}`, `Resources ${JSON.stringify(resources)}`, `Decision ${decision.outcome}: ${decision.reasons.join("; ")}`, ...decision.criteria.map(({ id, passed, detail }) => `  ${passed ? "pass" : "FAIL"} ${id}: ${detail}`), `Wrote ${relative(repository, outPath)}`, ""].join("\n"));

function findArtifact(root: string): string { const matches: string[] = []; const walk = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) walk(path); else if (path.endsWith(join("all-MiniLM-L6-v2", MODEL.artifact)) || (path.includes("all-MiniLM-L6-v2") && path.endsWith("model.onnx"))) matches.push(path); } }; walk(root); if (matches.length !== 1) throw new Error(`P18_MODEL_ARTIFACT_AMBIGUOUS:${matches.length}`); return matches[0] as string; }
/** Installed size of the model runtime closure, excluding the tsx/esbuild runner tooling. */
function dependencyBytes(): number { const store = join(here, "node_modules/.pnpm"); const size = (path: string): number => { const stat = statSync(path, { throwIfNoEntry: false }); if (stat === undefined) return 0; if (!stat.isDirectory()) return stat.size; return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isSymbolicLink() ? 0 : size(join(path, entry.name))), 0); }; return readdirSync(store).filter((entry) => !/^(tsx|esbuild|@esbuild\+|get-tsconfig|resolve-pkg-maps|fsevents|lock\.yaml|node_modules|@types\+node|undici-types)/u.test(entry)).reduce((sum, entry) => sum + size(join(store, entry)), 0); }
function git(command: readonly string[]): string { try { return execFileSync("git", [...command], { cwd: repository, encoding: "utf8" }).trim(); } catch { return "unknown"; } }
