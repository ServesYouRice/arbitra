import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runConfigSchema, type RunConfig } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import type { HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import { Orchestrator } from "../src/orchestrator.js";

const run = promisify(execFile);

/** One defect marker per line; a fixture auditor reports exactly the marked lines it is shown. */
export const defect = (id: string): string => `export const ${id.replaceAll("-", "_")} = JSON.parse(input) as never; // DEFECT-${id}`;
const padding = (name: string): string => Array.from({ length: 70 }, (_, index) => `// ${name} context line ${index} keeps this module large enough to need its own discovery scope.`).join("\n");

/** A module whose defect lines sit after `offset` unrelated lines. */
export function moduleSource(name: string, defects: readonly string[], options: { readonly offset?: number; readonly imports?: readonly string[] } = {}): string {
  return [...(options.imports ?? []).map((path) => `import "${path}";`), ...Array.from({ length: options.offset ?? 0 }, (_, index) => `// ${name} inserted line ${index}`), ...defects.map(defect), padding(name), ""].join("\n");
}

export interface ProviderCall { readonly stage: string; readonly activity: string; readonly user: string }

/**
 * A git repository audited by two model auditors and a planner through one fake provider.
 * Discovery is budgeted so that each top-level module is its own discovery unit.
 */
export async function incrementalFixture(files: Readonly<Record<string, string>>, options: { readonly git?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "arbitra-incremental-"));
  const write = async (tree: Readonly<Record<string, string | null>>) => {
    for (const [path, content] of Object.entries(tree)) {
      if (content === null) { await rm(join(root, path), { force: true }); continue; }
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, "utf8");
    }
  };
  await write(files);
  const git = async (...args: string[]) => (await run("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" })).stdout;
  if (options.git !== false) { await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "base"); }
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const template = example.models["auditor-a"];
  if (template === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const planTemplate = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const ids = ["auditor-a", "auditor-b", "planner"];
  const config: RunConfig = runConfigSchema.parse({ ...example, models: Object.fromEntries(ids.map((id) => [id, { ...template, modelId: id, independenceGroup: id }])),
    workflow: { preset: "audit-balanced", modelExecution: {
      endpoints: ids.map((id) => ({ id, providerId: "openai", transport: "openai-responses", endpoint: `https://${id}.example/v1`, apiKeyEnvVar: "FIXTURE_KEY" })),
      modelEndpoints: Object.fromEntries(ids.map((id) => [id, id])), roles: { planner: "planner", verifier: "planner" },
      maximumOutputTokens: 2_000, maximumDiscoveryTokens: 40_000, maximumTokens: 50_000_000, timeoutMs: 30_000, maximumRetries: 0,
      rateLimits: { openai: { rpm: 100_000, tpm: 1_000_000_000, maxConcurrent: 8 } },
    } },
  });
  const calls: ProviderCall[] = [];
  const failing = new Set<string>();
  const send = async (request: HttpRequest): Promise<HttpResponse> => {
    const body = request.body as { input?: { role: string; content: string }[] };
    let system = body.input?.find(({ role }) => role === "system")?.content ?? "";
    let user = body.input?.find(({ role }) => role === "user")?.content ?? "{}";
    if (user.startsWith('{"layer":"locked"')) {
      const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
      system = layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "";
      const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
      const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
      user = content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    }
    const model = /https:\/\/([^.]+)\.example/u.exec(request.url)?.[1] ?? "unknown";
    let output: unknown;
    let stage: string;
    if (system.startsWith("Audit the supplied")) {
      stage = "discovery";
      const prefix = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(system)?.[1] ?? "";
      const input = JSON.parse(user) as { files: { path: string; lines: { line: number; text: string }[] }[] };
      if ([...failing].some((path) => input.files.some((file) => file.path === path))) return { status: 503, headers: {}, body: {} };
      const marked = input.files.flatMap(({ path, lines }) => lines.filter(({ text }) => text.includes("// DEFECT-")).map(({ line, text }) => ({ path, line, text })));
      output = { findings: marked.map(({ path, line, text }, index) => {
        const name = /DEFECT-([\w-]+)/u.exec(text)?.[1] ?? "unknown";
        return { schemaVersion: 1, sourceFindingId: `${prefix}/${index + 1}`, category: "CORRECTNESS", title: `Unchecked parse ${name}`, severity: "high", status: "needs_verification", confidence: 0.7, productionBlocker: false,
          locations: [{ id: `L${index}`, path, startLine: line, endLine: line }], evidence: [{ id: `E${index}`, text, locationIds: [`L${index}`] }],
          problem: `Unvalidated JSON parse in ${name}`, recommendedFix: "Validate parsed input", productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [] };
      }), truncated: false, unexaminedDueToBudget: [], limitations: [] };
      calls.push({ stage, activity: `${model}:${input.files.map(({ path }) => path).join(",")}`, user });
    } else {
      if (system.startsWith("Compare the supplied candidate pair")) { stage = "merge-check"; output = { operations: [], findings: [], locations: [] }; }
      else if (system.startsWith("Classify the relationship")) { stage = "clustering"; output = { relationship: "unrelated", rationale: "Fixture: different modules" }; }
      else if (system.startsWith("Resolve the supplied")) { stage = "conflict"; output = { selection: "unresolved", evidenceIds: [], rationale: "Fixture" }; }
      else if (system.startsWith("Review every")) {
        stage = "review";
        const input = JSON.parse(user) as { round: number; candidates: Record<string, { candidateId: string; sources: { evidence: { id: string }[] }[] }> };
        output = { operations: Object.values(input.candidates).map(({ candidateId, sources }, index) => ({ operationId: `new:vote-${index}`, candidateId, authorId: "self", round: input.round, type: "accept", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)), reason: "Fixture review of supplied evidence" })), locations: [], findings: [] };
      } else if (system.startsWith("Answer the single")) {
        stage = "verification";
        const input = JSON.parse(user) as { request: { context: { citedContext: { evidenceId: string }[] } } };
        output = { outcome: "CONFIRMED", evidenceIds: input.request.context.citedContext.map(({ evidenceId }) => evidenceId), confidence: 0.8 };
      } else if (system.startsWith("Produce a complete")) {
        stage = "planner";
        const input = JSON.parse(user) as { canonicalIssues: { candidateId: string }[]; premiseReport: unknown };
        const acceptedIssueIds = input.canonicalIssues.map(({ candidateId }) => candidateId);
        output = { ...planTemplate, acceptedIssueIds, tasks: planTemplate.tasks.map((task) => ({ ...task, addresses: { ...task.addresses, issues: acceptedIssueIds } })),
          traceability: { ...planTemplate.traceability, issueToValidation: acceptedIssueIds.map((issueId) => ({ issueId, validationIds: ["VAL-001"] })) }, premiseReport: input.premiseReport };
      } else throw new Error(`UNKNOWN_FIXTURE_STAGE:${system.slice(0, 60)}`);
      calls.push({ stage, activity: model, user });
    }
    return { status: 200, headers: {}, body: { output_text: JSON.stringify(output), usage: { input_tokens: 100, output_tokens: 10 } } };
  };
  const orchestrator = () => new Orchestrator({ repository: root, stateDirectory: join(root, ".runs"), providerOptions: { client: { send }, credential: () => "fixture-credential" } });
  return { root, config, calls, write, git, fail: (path: string) => failing.add(path), recover: () => failing.clear(), orchestrator, cleanup: () => rm(root, { recursive: true, force: true }) };
}
