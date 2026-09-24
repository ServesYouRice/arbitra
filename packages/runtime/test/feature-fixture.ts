import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runConfigSchema } from "@arbitra/schemas/config.js";
import { planIRSchema } from "@arbitra/schemas/plan.js";
import { requirementsContractSchema } from "@arbitra/schemas/requirements.js";
import type { HttpRequest } from "@arbitra/providers/transport-contract.js";
import { Orchestrator } from "../src/orchestrator.js";

export async function featureFixture(root: string, options: { interactive?: boolean; highRisk?: boolean; reviewBlocked?: boolean; criticBlocking?: boolean; questions?: boolean; failPlanner?: boolean; limited?: boolean; requirementsRevisions?: number; acceptRevision?: boolean; failRevisionReview?: boolean; failRequirementsRevision?: boolean } = {}) {
  await writeFile(join(root, "session.ts"), "export const version = 1;\n");
  const example = runConfigSchema.parse(JSON.parse(await readFile(new URL("../../../examples/audit-balanced.json", import.meta.url), "utf8")));
  const profile = example.models["auditor-a"];
  if (profile === undefined) throw new Error("FIXTURE_PROFILE_ABSENT");
  const models = {
    planner: { ...profile, independenceGroup: "planner" },
    reviewer: { ...profile, provider: "anthropic", transport: "anthropic-messages", structuredOutputDialect: "anthropic_tool", independenceGroup: "reviewer" },
    critic: { ...profile, independenceGroup: "critic" },
  };
  const config = runConfigSchema.parse({ ...example, mode: "feature", scope: { kind: "repository" }, models, maxConsensusRounds: 1, workflow: {
    preset: "feature-simple", feature: { request: "Add session preferences", mode: options.interactive ? "interactive" : "automatic", maximumRequirementsRevisions: options.requirementsRevisions ?? 0, roles: { requirements: "planner", exploration: "planner", planner: "planner", reviewers: ["reviewer", "critic"], critic: "critic" } },
    modelExecution: {
      endpoints: [{ id: "primary", providerId: profile.provider, transport: profile.transport, endpoint: "https://fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }, { id: "anthropic", providerId: "anthropic", transport: "anthropic-messages", endpoint: "https://anthropic.fixture.example/v1", apiKeyEnvVar: "FIXTURE_KEY" }],
      modelEndpoints: { planner: "primary", critic: "primary", reviewer: "anthropic" }, maximumOutputTokens: 2000, maximumTokens: 1000000, maximumRetries: 0, timeoutMs: 30_000,
      rateLimits: { [profile.provider]: { rpm: 100, tpm: 1000000, maxConcurrent: 4 }, anthropic: { rpm: 100, tpm: 1000000, maxConcurrent: 4 } },
    },
  } });
  const draft = { assumptions: [{ id: "assumption", statement: "Keep existing sessions", confidence: "high" }], ambiguities: options.highRisk || options.interactive ? [{ id: "migration", question: "Migrate?", proposedDefault: "Keep sessions", blastRadius: "high" }] : [], acceptance: [{ id: "acceptance", assertion: "New sessions work" }], outOfScope: [] };
  const plan = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  plan.mode = "feature"; plan.acceptedIssueIds = []; plan.traceability.issueToValidation = [];
  plan.premiseReport = { status: "unavailable", interpretation: "smoke_test_only_not_proof", limitations: ["real_model_premise_requires_ground_truth_evaluation"] };
  for (const task of plan.tasks) { task.addresses.issues = []; task.addresses.requirements = ["acceptance"]; }
  plan.traceability.requirementLinks.links = [{ requirementId: "acceptance", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  if (options.questions) plan.unresolvedQuestions.push({ id: "decision", question: "Choose migration strategy", blocking: true, blastRadius: "high" });
  const calls: { stage: string; url: string; input: unknown }[] = [];
  let failPlanner = options.failPlanner ?? false;
  let reviewBlocked = options.reviewBlocked ?? false;
  let failRevisionReview = options.failRevisionReview ?? false;
  let failRequirementsRevision = options.failRequirementsRevision ?? false;
  const providerOptions = { credential: () => "fixture-credential", client: { async send(request: HttpRequest) {
    const body = request.body as { input?: { role: string; content: string }[]; messages?: { content: string }[] };
    const user = body.input?.find(({ role }) => role === "user")?.content ?? body.messages?.[0]?.content ?? "";
    const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
    const system = layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? "";
    const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
    const content = /-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}";
    const input = JSON.parse(content.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) as Record<string, unknown>;
    let stage: string; let output: unknown;
    if (system.startsWith("Derive a requirements")) { stage = "requirements"; output = draft; }
    else if (system.startsWith("Explore affected")) {
      stage = "exploration"; output = { summary: "Session preferences", preflight: { affectedSurfaces: [{ id: "sessions", paths: ["session.ts"], riskCategories: [], relevantTo: ["acceptance"] }], securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1 }, evidence: [{ surfaceId: "sessions", path: "session.ts", startLine: 1, endLine: 1, text: "export const version = 1;" }], limitations: options.limited ? ["Fixture coverage gap"] : [] };
    } else if (system.startsWith("Independently review every")) {
      stage = "review";
      const contract = input["requirements"] as { assumptions: { id: string }[]; ambiguities: { id: string }[]; acceptance: { id: string }[] };
      output = { summary: "Review requirements", decisions: [...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => ({ requirementId: id, disposition: reviewBlocked && !(options.acceptRevision && input["revisionContext"] !== undefined) ? "uncertain" : "accept", reason: "Source checked", proposedChange: null, evidence: [] })), limitations: [] };
    } else if (system.startsWith("Propose a revised Feature requirements")) {
      stage = "requirements-revision";
      const contract = requirementsContractSchema.parse(input["requirements"]);
      output = { draft: { assumptions: contract.assumptions.map((assumption) => ({ ...assumption, statement: `${assumption.statement} Clarified.` })), ambiguities: contract.ambiguities.map((ambiguity) => ({ ...ambiguity, proposedDefault: `${ambiguity.proposedDefault} revised` })), acceptance: contract.acceptance, outOfScope: contract.outOfScope },
        lineage: [...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => ({ previousRequirementId: id, nextRequirementIds: [id], rationale: "Retain responsibility with clarified defaults" })), addedRequirementIds: [],
        resolutions: (input["blockingRequirementIds"] as string[]).map((requirementId) => ({ requirementId, resolution: "Clarified defaults against source" })) };
    } else if (system.startsWith("Create one coherent")) { stage = "planner"; output = plan; }
    else if (system.startsWith("Independently critique")) {
      stage = "critic"; output = { summary: "Plan reviewed", items: options.criticBlocking ? [{ id: "critique", category: "weak_verification", blocking: true, summary: "Missing migration validation", taskIds: ["TASK-001"], issueIds: [] }] : [] };
    } else if (system.startsWith("Revise the complete Feature")) { stage = "revision"; output = { plan, resolutions: [{ critiqueItemId: "critique", resolution: "Added migration validation" }] }; }
    else throw new Error(`UNEXPECTED_FEATURE_PROMPT:${system}`);
    calls.push({ stage, url: request.url, input });
    if (stage === "review" && input["revisionContext"] !== undefined && failRevisionReview) { failRevisionReview = false; throw new Error("FIXTURE_REVISION_REVIEW_INTERRUPTED"); }
    if (stage === "requirements-revision" && failRequirementsRevision) { failRequirementsRevision = false; throw new Error("FIXTURE_REQUIREMENTS_REVISION_INTERRUPTED"); }
    if (stage === "planner" && failPlanner) { failPlanner = false; throw new Error("FIXTURE_PLANNER_INTERRUPTED"); }
    return { status: 200, headers: {}, body: request.url.includes("anthropic.fixture")
      ? { content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 30 } }
      : { output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 30 } } };
  } } };
  const orchestrator = () => new Orchestrator({ repository: root, providerOptions });
  return { config, draft, plan, calls, providerOptions, orchestrator, acceptReview: () => { reviewBlocked = false; } };
}
