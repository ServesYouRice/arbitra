import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planIRSchema, type PlanIR } from "@arbitra/schemas/plan.js";
import type { HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";
import type { TestSandbox } from "../src/test-sandbox.js";

/**
 * Credential-free fixture provider for smoke-running the shipped model-backed templates
 * through the public runtime. It answers each stage by its locked instruction, in the
 * native wire format of whichever protocol the request used. It proves wiring,
 * preflight, durable stages and handoff publication — never model quality.
 */
export type WireProtocol = "openai-responses" | "openai-chat" | "anthropic-messages" | "gemini-native";
export interface SmokeCall { readonly stage: string; readonly protocol: WireProtocol; readonly url: string }

export const SMOKE_SOURCE = "export const sessionVersion = 1;";
export const SMOKE_TEST = "test('existing', () => {});";

/** A tiny repository matching the paths the templates grant and check. */
export async function smokeRepository(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "src", "session.ts"), `${SMOKE_SOURCE}\n`);
  await writeFile(join(root, "test", "session.test.ts"), `${SMOKE_TEST}\n`);
  await writeFile(join(root, "package.json"), '{"name":"smoke","private":true,"scripts":{"test":"vitest run"}}\n');
}

export async function smokeProvider(options: { highImpactAmbiguity?: boolean } = {}) {
  const template = planIRSchema.parse(JSON.parse(await readFile(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")));
  const calls: SmokeCall[] = [];
  const respond = (stage: string, input: Record<string, unknown>, system: string, body: string): unknown => {
    switch (stage) {
      case "discovery": {
        const auditorId = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(system)?.[1] ?? "auditor";
        return { findings: [{ schemaVersion: 1, sourceFindingId: `${auditorId}/1`, category: "CORRECTNESS", title: "Unchecked session version", severity: "high", status: "needs_verification", confidence: 0.5, productionBlocker: false,
          locations: [{ id: `${auditorId}-L1`, path: "src/session.ts", startLine: 1, endLine: 1 }], evidence: [{ id: `${auditorId}-E1`, text: SMOKE_SOURCE, locationIds: [`${auditorId}-L1`] }],
          problem: "Fixture claim", recommendedFix: "Validate the version", productionImpact: "", trigger: "", verification: "", dependencies: [], relatedRisks: [] }], truncated: false, unexaminedDueToBudget: [], limitations: [] };
      }
      case "merge-check": return { operations: [], findings: [], locations: [] };
      case "clustering": return { relationship: "same_root_cause", rationale: "Fixture: identical cited source and remediation" };
      case "conflict": {
        const candidates = input["candidates"] as Record<string, { sources: { evidence: { id: string }[] }[] }>;
        return { selection: "unresolved", evidenceIds: Object.values(candidates).flatMap(({ sources }) => sources.flatMap(({ evidence }) => evidence.map(({ id }) => id))), rationale: "Fixture leaves the conflict to the operator" };
      }
      case "review": {
        const candidates = input["candidates"] as Record<string, { candidateId: string; sources: { evidence: { id: string }[] }[] }>;
        return { operations: Object.values(candidates).map(({ candidateId, sources }, index) => ({ operationId: `new:vote-${index}`, candidateId, authorId: "self", round: input["round"], type: "accept", citedEvidenceIds: sources.flatMap(({ evidence }) => evidence.map(({ id }) => id)), reason: "Fixture review of supplied evidence" })), locations: [], findings: [] };
      }
      case "verification": {
        const request = input["request"] as { context: { citedContext: { evidenceId: string }[] } };
        return { outcome: "CONFIRMED", evidenceIds: request.context.citedContext.map(({ evidenceId }) => evidenceId), confidence: 0.8 };
      }
      case "audit-planner": {
        const acceptedIssueIds = (input["canonicalIssues"] as { candidateId: string }[]).map(({ candidateId }) => candidateId);
        return { ...template, acceptedIssueIds, tasks: template.tasks.map((task) => ({ ...task, addresses: { ...task.addresses, issues: acceptedIssueIds } })),
          traceability: { ...template.traceability, issueToValidation: acceptedIssueIds.map((issueId) => ({ issueId, validationIds: ["VAL-001"] })) }, premiseReport: input["premiseReport"] };
      }
      case "audit-critic": case "feature-critic": return { summary: "Fixture critique", items: [] };
      case "requirements": return { assumptions: [{ id: "assumption", statement: "Keep existing sessions", confidence: "high" }],
        ambiguities: options.highImpactAmbiguity === true ? [{ id: "migration", question: "Migrate existing sessions?", proposedDefault: "Keep existing sessions", blastRadius: "high" }] : [],
        acceptance: [{ id: "acceptance", assertion: "New sessions record their version" }], outOfScope: [] };
      case "exploration": return { summary: "Session version", preflight: { affectedSurfaces: [{ id: "sessions", paths: ["src/session.ts"], riskCategories: [], relevantTo: ["acceptance"] }], securitySensitiveSurfaceCount: 0, migrationInvolvement: false, architectureBreadth: 1, testingComplexity: 1 },
        evidence: [{ surfaceId: "sessions", path: "src/session.ts", startLine: 1, endLine: 1, text: SMOKE_SOURCE }], limitations: [] };
      case "feature-review": {
        const contract = input["requirements"] as { assumptions: { id: string }[]; ambiguities: { id: string }[]; acceptance: { id: string }[] };
        return { summary: "Fixture review", decisions: [...contract.assumptions, ...contract.ambiguities, ...contract.acceptance].map(({ id }) => ({ requirementId: id, disposition: "accept", reason: "Source checked", proposedChange: null, evidence: [] })), limitations: [] };
      }
      case "feature-planner": return featurePlan(template);
      case "testing-risk": return { summary: "Session coverage", surfaces: [{ id: "session", paths: ["src/session.ts"], categories: ["unit"], severity: "high", failureModes: ["session version lost"], evidence: [{ path: "src/session.ts", startLine: 1, endLine: 1, text: SMOKE_SOURCE }] }],
        reviewedSourcePaths: ["src/session.ts"], reviewedTestPaths: ["test/session.test.ts"], limitations: [] };
      case "testing-selection": return { selectedGapIds: ["GAP-session-1"], rejected: [], limitations: [] };
      case "testing-planner": return testingPlan(template);
      case "testing-writer": return /function_call_output|"role":"tool"|tool_result|functionResponse/u.test(body)
        ? { summary: "Added a session version assertion", limitations: [] }
        : { toolCall: { name: "testing_write_file", arguments: { path: "test/session.test.ts", expectedHash: createHash("sha256").update(`${SMOKE_TEST}\n`).digest("hex"), content: "test('session version', () => { expect(sessionVersion).toBe(1); });\n" } } };
      default: throw new Error(`SMOKE_STAGE_UNSUPPORTED:${stage}`);
    }
  };
  const providerOptions: TransportFactoryOptions = {
    // Credential-free: a constant stands in for the environment. No network is used.
    credential: () => "smoke-fixture-credential",
    client: { async send(request: HttpRequest): Promise<HttpResponse> {
      const protocol = protocolOf(request.url);
      const { system, input } = decode(protocol, request.body);
      const stage = stageOf(system);
      calls.push({ stage, protocol, url: request.url });
      const output = respond(stage, input, system, JSON.stringify(request.body));
      return { status: 200, headers: {}, body: encode(protocol, output) };
    } },
  };
  let checks = 0;
  const sandbox: TestSandbox = {
    async inspect() { return { engine: "available", image: "present", detail: null }; },
    async recover() {},
    async run(_snapshot, policy, check) {
      checks += 1;
      return { driver: "docker", image: policy.image, checkId: check.id, isolation: "read_only_snapshot_no_network", status: "exited", stopped: null, cleanupCompleted: true, exitCode: 0, stdout: "fixture verification", stderr: "" };
    },
  };
  return { providerOptions, sandbox, calls, checks: () => checks };
}

function featurePlan(template: PlanIR): PlanIR {
  const plan = structuredClone(template);
  plan.mode = "feature"; plan.acceptedIssueIds = []; plan.traceability.issueToValidation = [];
  plan.premiseReport = { status: "unavailable", interpretation: "smoke_test_only_not_proof", limitations: ["real_model_premise_requires_ground_truth_evaluation"] };
  for (const task of plan.tasks) { task.addresses.issues = []; task.addresses.requirements = ["acceptance"]; }
  plan.traceability.requirementLinks.links = [{ requirementId: "acceptance", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  return plan;
}

function testingPlan(template: PlanIR): PlanIR {
  const plan = featurePlan(template);
  plan.mode = "testing";
  plan.traceability.requirementLinks.links = [{ requirementId: "GAP-session-1", taskIds: ["TASK-001"], validationIds: ["VAL-001"] }];
  for (const task of plan.tasks) {
    task.addresses.requirements = ["GAP-session-1"];
    task.scope.likelyFiles = ["test/session.test.ts"];
    task.readFirst = ["src/session.ts", "test/session.test.ts"];
    task.verification.commands = [{ command: "npm run test", expectedExitCode: 0, executionPolicy: "derived_repository_script" }];
  }
  return plan;
}

const STAGES: readonly (readonly [string, string])[] = [
  ["Audit the supplied", "discovery"], ["Compare the supplied candidate pair", "merge-check"], ["Classify the relationship", "clustering"],
  ["Resolve the supplied", "conflict"], ["Review every", "review"], ["Answer the single", "verification"], ["Produce a complete", "audit-planner"],
  ["Critique the plan", "audit-critic"], ["Derive a requirements", "requirements"], ["Explore affected", "exploration"],
  ["Independently review every", "feature-review"], ["Create one coherent Feature", "feature-planner"], ["Independently critique", "feature-critic"],
  ["Identify production-risk surfaces", "testing-risk"], ["Select Testing gaps", "testing-selection"], ["Create one coherent Testing", "testing-planner"],
  ["Implement the assigned Testing task", "testing-writer"],
];
function stageOf(system: string): string {
  const match = STAGES.find(([prefix]) => system.startsWith(prefix));
  if (match === undefined) throw new Error(`SMOKE_UNKNOWN_STAGE:${system.slice(0, 80)}`);
  return match[1];
}

function protocolOf(url: string): WireProtocol {
  const path = new URL(url).pathname;
  if (path.endsWith("/responses")) return "openai-responses";
  if (path.endsWith("/chat/completions")) return "openai-chat";
  if (path.endsWith("/messages")) return "anthropic-messages";
  if (path.endsWith(":generateContent")) return "gemini-native";
  throw new Error(`SMOKE_UNKNOWN_PROTOCOL:${path}`);
}

interface WireBody {
  input?: { role?: string; content?: unknown }[]; messages?: { role?: string; content?: unknown }[]; system?: string;
  systemInstruction?: { parts: { text: string }[] }; contents?: { parts: { text?: string }[] }[];
}
function decode(protocol: WireProtocol, value: unknown): { system: string; input: Record<string, unknown> } {
  const body = value as WireBody;
  const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
  let system = ""; let user = "";
  if (protocol === "openai-responses") { system = text(body.input?.find(({ role }) => role === "system")?.content); user = text(body.input?.find(({ role }) => role === "user")?.content); }
  if (protocol === "openai-chat") { system = text(body.messages?.find(({ role }) => role === "system")?.content); user = text(body.messages?.find(({ role }) => role === "user")?.content); }
  if (protocol === "anthropic-messages") { system = body.system ?? ""; user = text(body.messages?.find(({ role }) => role === "user")?.content); }
  if (protocol === "gemini-native") { system = body.systemInstruction?.parts.map(({ text: part }) => part).join("\n") ?? ""; user = body.contents?.[0]?.parts.map(({ text: part }) => part ?? "").join("") ?? ""; }
  if (user.startsWith('{"layer":"locked"')) {
    // Compiled prompts carry the instruction and framed untrusted input as JSON lines.
    const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
    system = layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? system;
    const framed = layers.flatMap(({ value }) => value.artifacts ?? [])[0] ?? "";
    user = (/-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  let input: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(user); if (typeof parsed === "object" && parsed !== null) input = parsed as Record<string, unknown>; } catch { input = {}; }
  return { system, input };
}

function encode(protocol: WireProtocol, output: unknown): unknown {
  const call = (output as { toolCall?: { name: string; arguments: unknown } }).toolCall;
  const text = JSON.stringify(output);
  switch (protocol) {
    case "openai-responses": return call === undefined ? { output_text: text, usage: { input_tokens: 20, output_tokens: 30 } }
      : { output: [{ type: "function_call", call_id: "smoke-call", name: call.name, arguments: JSON.stringify(call.arguments) }], usage: { input_tokens: 20, output_tokens: 30 } };
    case "openai-chat": return { choices: [{ message: call === undefined ? { role: "assistant", content: text } : { role: "assistant", content: null, tool_calls: [{ id: "smoke-call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }], usage: { prompt_tokens: 20, completion_tokens: 30 } };
    case "anthropic-messages": return { content: call === undefined ? [{ type: "text", text }] : [{ type: "tool_use", id: "smoke-call", name: call.name, input: call.arguments }], stop_reason: call === undefined ? "end_turn" : "tool_use", usage: { input_tokens: 20, output_tokens: 30 } };
    case "gemini-native": return { candidates: [{ content: { parts: call === undefined ? [{ text }] : [{ functionCall: { id: "smoke-call", name: call.name, args: call.arguments } }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30 } };
  }
}
