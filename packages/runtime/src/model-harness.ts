import { createHash } from "node:crypto";
import { compile } from "@arbitra/core/prompt/compiler.js";
import { CanonicalHarnessAdapter } from "@arbitra/harness/canonical/adapter.js";
import type { HarnessEvent } from "@arbitra/harness/adapter.js";
import { CANONICAL_HARNESS_PROFILE } from "@arbitra/harness/profile.js";
import { modelTurnResultSchema } from "@arbitra/schemas/model-results.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { frameUntrusted } from "@arbitra/security/framing";
import { redactSecrets } from "@arbitra/security/redaction";
import { ModelActivities, type ModelActivityRequest } from "./model-activities.js";
import { snapshotTools, SNAPSHOT_TOOLS } from "./snapshot-tools.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";

/** Replays durable model turns through the canonical read-only tool loop. */
export class ModelHarness {
  constructor(private readonly activities: ModelActivities, private readonly config: RunConfig, private readonly snapshot: RepositorySnapshot, private readonly store: RunStore) {}

  estimateInitialTokens(input: ModelActivityRequest<unknown>): number {
    const { initialMessages, tools, execution } = prepareModelInput(input, this.config);
    return Buffer.byteLength(JSON.stringify({ messages: initialMessages, tools }), "utf8") + execution.maximumOutputTokens;
  }

  async invoke<T>(input: ModelActivityRequest<T>): Promise<T> {
    const { profile, execution, tools, compiled, initialMessages, discovery } = prepareModelInput(input, this.config);
    const key = createHash("sha256").update(input.activityId).digest("hex");
    if (compiled !== undefined) await this.store.publish(`compiled-prompt-${key}`, { text: compiled.text, provenance: compiled.provenance, breakpoints: compiled.breakpoints }, input.activityId);
    const allowedPaths = input.sourcePaths === undefined ? null : new Set(input.sourcePaths);
    const toolSet = snapshotTools(allowedPaths === null ? this.snapshot : { ...this.snapshot, files: this.snapshot.files.filter(({ path }) => allowedPaths.has(path)) }, this.store, input.activityId);
    const adapter = new CanonicalHarnessAdapter({ invoke: async (request, context) => this.activities.invoke({
      ...input, activityId: `${input.activityId}/turn-${context.turn}`, messages: context.turn === 0 ? initialMessages : [
        ...initialMessages, ...request.messages.slice(1),
      ], tools: request.tools, responseMode: "harness_turn", schema: modelTurnResultSchema,
      harnessIdentity: { id: CANONICAL_HARNESS_PROFILE.id, version: CANONICAL_HARNESS_PROFILE.version, policyHash: createHash("sha256").update(JSON.stringify(CANONICAL_HARNESS_PROFILE.policy)).digest("hex") },
    }) });
    const prompt = compiled ?? { text: JSON.stringify(initialMessages), hash: createHash("sha256").update(JSON.stringify(initialMessages)).digest("hex") };
    const run = adapter.run({ id: input.activityId, modelId: profile.modelId, maximumOutputTokens: execution.maximumOutputTokens, maxToolTurns: profile.supports.tools ? profile.quirks.toolLoopLimit : 0 }, prompt, tools, toolSet.runtime, {
      mode: this.config.mode, round: discovery ? 0 : 1,
      requirements: { structuredEvents: true, enforcesExternalPolicy: true, reportsUsage: true }, signal: input.signal,
      toolContext: { protect: (content, meta) => frameUntrusted(redactSecrets(content).text, meta) },
    });
    const events: HarnessEvent[] = [];
    try {
      for await (const event of run.events) {
        events.push(event);
        if (event.type !== "completed") continue;
        if (event.refusal !== null) throw new Error("MODEL_ACTIVITY_REFUSED");
        let output: unknown;
        try { output = JSON.parse(event.text ?? ""); } catch { throw new Error("MODEL_ACTIVITY_INVALID_JSON"); }
        return input.schema.parse(output);
      }
      throw new Error("HARNESS_COMPLETION_ABSENT");
    } finally {
      await this.store.publish(`harness-${key}`, { activityId: input.activityId, profile: CANONICAL_HARNESS_PROFILE, events,
        inspection: toolSet.footprints.inspection(input.activityId), exposure: toolSet.footprints.exposure(input.activityId) }, input.activityId);
    }
  }
}

function prepareModelInput(input: ModelActivityRequest<unknown>, config: RunConfig) {
    const profile = Object.hasOwn(config.models, input.modelProfileId) ? config.models[input.modelProfileId] : undefined;
    if (profile === undefined) throw new Error(`UNKNOWN_MODEL_PROFILE:${input.modelProfileId}`);
    const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
    const tools = profile.supports.tools ? SNAPSHOT_TOOLS : [];
    const overrides = config.promptOverrides[input.protocolAsset?.protocolId ?? input.protocol];
    if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)
      || Object.entries(overrides).some(([key, value]) => !["before", "after"].includes(key) || typeof value !== "string"))) throw new Error("INVALID_PROTOCOL_PROMPT_OVERRIDE");
    const contextArtifacts = input.messages.filter(({ role }) => role !== "system").map(({ content }, index) => ({ sourceId: `${input.activityId}:input-${index}`, content }));
    const discovery = input.activityId.endsWith("/discovery");
    const compiled = input.protocolAsset === undefined ? undefined : compile({
      protocol: input.protocolAsset, outputSchema: input.outputSchema ?? {}, toolDefinitions: tools,
      projectContext: { mode: config.mode },
      stableRepositoryArtifacts: discovery ? contextArtifacts : [], roundArtifacts: discovery ? [] : contextArtifacts,
      overrides: (overrides ?? {}) as { before?: string; after?: string },
      instruction: input.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n"),
      outputContract: "Return only JSON matching the locked output schema.", nodeId: input.activityId, modelId: profile.modelId,
      security: { redact: (text) => { const result = redactSecrets(text); return { text: result.text, redactionCount: result.redactions.length }; }, frame: frameUntrusted },
    });
    const initialMessages = compiled === undefined ? input.messages : [{ role: "user" as const, content: compiled.text }];
    return { profile, execution, tools, compiled, initialMessages, discovery };
}
