import { readFileSync } from "node:fs";

import type { HttpRequest, HttpResponse } from "@arbitra/providers/transport-contract.js";
import type { TransportFactoryOptions } from "@arbitra/providers/registry.js";

/**
 * Credential-free scripted provider for the P06 driver tests. It answers each Audit stage by
 * its locked instruction in the Gemini-native or OpenAI-chat wire format, and reports one
 * finding at `src/session.ts:1` quoting `PREMISE_SOURCE`. It proves wiring, never model quality.
 */
export const PREMISE_SOURCE = "export const sessionVersion = 1;";
export interface ScriptedCall { readonly stage: string; readonly protocol: "gemini-native" | "openai-chat" }

const STAGES: readonly (readonly [string, string])[] = [
  ["Audit the supplied", "discovery"], ["Compare the supplied candidate pair", "merge-check"], ["Classify the relationship", "clustering"], ["Resolve the supplied", "conflict"],
  ["Review every", "review"], ["Answer the single", "verification"], ["Produce a complete", "audit-planner"], ["Critique the plan", "audit-critic"],
];

export function premiseProvider(): { readonly providerOptions: TransportFactoryOptions; readonly calls: readonly ScriptedCall[] } {
  const template = JSON.parse(readFileSync(new URL("../../schemas/test/golden/plan-ir.valid.json", import.meta.url), "utf8")) as { tasks: { addresses: Record<string, unknown> }[]; traceability: Record<string, unknown> };
  const calls: ScriptedCall[] = [];
  const respond = (stage: string, input: Record<string, unknown>, system: string): unknown => {
    switch (stage) {
      case "discovery": {
        const auditorId = /Every sourceFindingId must start with (.+)\/ and be unique/u.exec(system)?.[1] ?? "auditor";
        return { findings: [{ schemaVersion: 1, sourceFindingId: `${auditorId}/1`, category: "CORRECTNESS", title: "Unchecked session version", severity: "high", status: "needs_verification", confidence: 0.5, productionBlocker: false,
          locations: [{ id: `${auditorId}-L1`, path: "src/session.ts", startLine: 1, endLine: 1 }], evidence: [{ id: `${auditorId}-E1`, text: PREMISE_SOURCE, locationIds: [`${auditorId}-L1`] }],
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
      case "audit-critic": return { summary: "Fixture critique", items: [] };
      default: throw new Error(`PREMISE_PROVIDER_STAGE_UNSUPPORTED:${stage}`);
    }
  };
  const providerOptions: TransportFactoryOptions = {
    // Credential-free: a constant stands in for the environment. No network is used.
    credential: () => "premise-fixture-credential",
    client: { async send(request: HttpRequest): Promise<HttpResponse> {
      const protocol = new URL(request.url).pathname.endsWith("/chat/completions") ? "openai-chat" as const : "gemini-native" as const;
      const { system, input } = decode(protocol, request.body);
      const stage = STAGES.find(([prefix]) => system.startsWith(prefix))?.[1];
      if (stage === undefined) throw new Error(`PREMISE_PROVIDER_UNKNOWN_STAGE:${system.slice(0, 80)}`);
      calls.push({ stage, protocol });
      const text = JSON.stringify(respond(stage, input, system));
      return { status: 200, headers: {}, body: protocol === "openai-chat"
        ? { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 20, completion_tokens: 30 } }
        : { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30 } } };
    } },
  };
  return { providerOptions, calls };
}

function decode(protocol: ScriptedCall["protocol"], value: unknown): { system: string; input: Record<string, unknown> } {
  const body = value as { messages?: { role?: string; content?: unknown }[]; systemInstruction?: { parts: { text: string }[] }; contents?: { parts: { text?: string }[] }[] };
  const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
  let system = protocol === "openai-chat" ? text(body.messages?.find(({ role }) => role === "system")?.content) : body.systemInstruction?.parts.map(({ text: part }) => part).join("\n") ?? "";
  let user = protocol === "openai-chat" ? text(body.messages?.find(({ role }) => role === "user")?.content) : body.contents?.[0]?.parts.map(({ text: part }) => part ?? "").join("") ?? "";
  if (user.startsWith('{"layer":"locked"')) {
    // Compiled prompts carry the instruction and framed untrusted input as JSON lines.
    const layers = user.split("\n").map((line) => JSON.parse(line) as { layer: string; value: { instruction?: string; artifacts?: string[] } });
    system = layers.find(({ layer }) => layer === "instruction")?.value.instruction ?? system;
    const framed = layers.flatMap(({ value: layer }) => layer.artifacts ?? [])[0] ?? "";
    user = (/-->\n([\s\S]*)\n<\/repository_content>$/u.exec(framed)?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  let input: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(user); if (typeof parsed === "object" && parsed !== null) input = parsed as Record<string, unknown>; } catch { input = {}; }
  return { system, input };
}
