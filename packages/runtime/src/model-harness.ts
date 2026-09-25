import { createHash } from "node:crypto";
import { compile } from "@arbitra/core/prompt/compiler.js";
import { CanonicalHarnessAdapter } from "@arbitra/harness/canonical/adapter.js";
import type { HarnessEvent } from "@arbitra/harness/adapter.js";
import { CANONICAL_HARNESS_PROFILE, CANONICAL_TESTING_HARNESS_PROFILE } from "@arbitra/harness/profile.js";
import { modelTurnResultSchema } from "@arbitra/schemas/model-results.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { frameUntrusted } from "@arbitra/security/framing";
import { redactSecrets } from "@arbitra/security/redaction";
import { boundModelHistory } from "./model-history.js";
import { ModelOutputLimitError, outputLimitKind } from "./context-budget.js";
import { ModelActivities, parsePromptJson, type ModelActivityRequest } from "./model-activities.js";
import { snapshotTools, SNAPSHOT_TOOLS } from "./snapshot-tools.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";
import type { TestingToolExtension } from "./testing-tools.js";

/** Replays durable model turns through the canonical read-only tool loop. */
export class ModelHarness {
  #outputLimited: Promise<Set<string>> | undefined;
  constructor(private readonly activities: ModelActivities, private readonly config: RunConfig, private readonly snapshot: RepositorySnapshot, private readonly store: RunStore, private readonly testing?: TestingToolExtension) {}

  /** Whether this durable activity previously stopped at the output ceiling. */
  async outputLimited(activityId: string): Promise<boolean> {
    this.#outputLimited ??= this.store.listArtifacts().then((artifacts) => new Set(artifacts.map(({ kind }) => kind).filter((kind) => kind.startsWith("model-output-limit-"))));
    return (await this.#outputLimited).has(outputLimitKind(activityId));
  }

  estimateInitialTokens(input: ModelActivityRequest<unknown>): number {
    const { initialMessages, tools, execution } = prepareModelInput(input, this.config, this.testing);
    return Buffer.byteLength(JSON.stringify({ messages: initialMessages, tools }), "utf8") + execution.maximumOutputTokens;
  }

  async invoke<T>(input: ModelActivityRequest<T>): Promise<T> {
    const execution = providerExecutionSchema.parse(this.config.workflow["modelExecution"]);
    let attempt = input;
    for (let repair = 1; ; repair += 1) {
      try { return await this.invokeBounded(attempt); }
      catch (error) {
        if (!(error instanceof ModelOutputRejectedError)) throw error;
        // Exhausted: rethrow the validation error itself, marked so a stage that can proceed
        // without this one reply (peer review) can tell it from a provider or policy failure.
        if (repair > execution.maximumOutputRepairs) throw error.cause instanceof Error ? Object.assign(error.cause, { modelOutputRejected: true }) : error.cause;
        // A rejected reply is answered once more, as its own durable activity, with the
        // validation failure and the rejected reply (as untrusted data) appended.
        attempt = { ...input, activityId: `${input.activityId}/repair-${repair}`, messages: [...input.messages, { role: "user", content: JSON.stringify({ outputRejected: {
          attempt: repair, reason: error.reason, rejectedReply: error.reply.slice(0, 32_000),
          instruction: "Your previous reply was rejected by validation for the reason given. Return one corrected, complete reply that satisfies the locked output schema and every stated rule. Quote evidence exactly as it appears in the source." } }) }] };
      }
    }
  }

  private async invokeBounded<T>(input: ModelActivityRequest<T>): Promise<T> {
    // Never repeat spend on an activity already known to exceed the output ceiling.
    if (await this.outputLimited(input.activityId)) throw new ModelOutputLimitError(input.activityId);
    try { return await this.invokeTurns(input); }
    catch (error) {
      if (!(error instanceof ModelOutputLimitError)) throw error;
      const execution = providerExecutionSchema.parse(this.config.workflow["modelExecution"]);
      await this.store.publish(outputLimitKind(input.activityId), { activityId: input.activityId, turnActivityId: error.activityId, maximumOutputTokens: execution.maximumOutputTokens }, input.activityId);
      (await (this.#outputLimited ?? Promise.resolve(new Set<string>()))).add(outputLimitKind(input.activityId));
      throw new ModelOutputLimitError(input.activityId);
    }
  }

  private async invokeTurns<T>(input: ModelActivityRequest<T>): Promise<T> {
    const { profile, execution, tools, compiled, initialMessages, discovery } = prepareModelInput(input, this.config, this.testing);
    const harnessProfile = this.testing === undefined ? CANONICAL_HARNESS_PROFILE : CANONICAL_TESTING_HARNESS_PROFILE;
    const key = createHash("sha256").update(input.activityId).digest("hex");
    if (compiled !== undefined) await this.store.publish(`compiled-prompt-${key}`, { text: compiled.text, provenance: compiled.provenance, breakpoints: compiled.breakpoints }, input.activityId);
    const allowedPaths = input.sourcePaths === undefined ? null : new Set(input.sourcePaths);
    const toolSet = snapshotTools(allowedPaths === null ? this.snapshot : { ...this.snapshot, files: this.snapshot.files.filter(({ path }) => allowedPaths.has(path)) }, this.store, input.activityId);
    const maximumContext = Math.min(execution.maximumContextTokens ?? 128_000, profile.limits.contextTokens ?? Number.POSITIVE_INFINITY);
    const adapter = new CanonicalHarnessAdapter({ invoke: async (request, context) => {
      const bounded = await boundModelHistory(initialMessages, context.turn === 0 ? [] : request.messages.slice(1),
        (messages) => Buffer.byteLength(JSON.stringify({ messages, tools: request.tools }), "utf8") + execution.maximumOutputTokens <= maximumContext, toolSet.archive);
      if (bounded.archiveRef !== null) await this.store.publish(`model-history-${key}-${context.turn}`, { activityId: input.activityId, turn: context.turn, archiveRef: bounded.archiveRef, archivedMessages: bounded.archivedMessages, maximumEstimatedTokens: maximumContext });
      return this.activities.invoke({
        ...input, activityId: `${input.activityId}/turn-${context.turn}`, messages: bounded.messages,
        tools: request.tools, responseMode: "harness_turn", schema: modelTurnResultSchema,
        harnessIdentity: { id: harnessProfile.id, version: harnessProfile.version, policyHash: createHash("sha256").update(JSON.stringify({ policy: harnessProfile.policy, sourcePaths: input.sourcePaths === undefined ? null : [...input.sourcePaths].sort(), historyPolicy: "archive-complete-exchanges-v1", maximumContext, ...(this.testing === undefined ? {} : { testingWritePolicy: this.testing.policyIdentity }) })).digest("hex") },
      });
    } }, harnessProfile);
    const prompt = compiled ?? { text: JSON.stringify(initialMessages), hash: createHash("sha256").update(JSON.stringify(initialMessages)).digest("hex") };
    const runtime = this.testing?.createRuntime(toolSet.runtime, input.activityId, input.signal, input.sourcePaths) ?? toolSet.runtime;
    const run = adapter.run({ id: input.activityId, modelId: profile.modelId, maximumOutputTokens: execution.maximumOutputTokens, maxToolTurns: profile.supports.tools ? profile.quirks.toolLoopLimit : 0 }, prompt, tools, runtime, {
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
        try { return input.schema.parse(parsePromptJson(event.text ?? "")); }
        catch (error) { throw new ModelOutputRejectedError(error, event.text ?? ""); }
      }
      throw new Error("HARNESS_COMPLETION_ABSENT");
    } finally {
      await this.store.publish(`harness-${key}`, { activityId: input.activityId, profile: harnessProfile, events,
        inspection: toolSet.footprints.inspection(input.activityId), exposure: toolSet.footprints.exposure(input.activityId) }, input.activityId);
    }
  }
}

export function isModelOutputRejection(error: unknown): boolean { return error instanceof Error && (error as { modelOutputRejected?: unknown }).modelOutputRejected === true; }

/** A reply that arrived but failed output parsing or validation; never a provider or policy failure. */
export class ModelOutputRejectedError extends Error {
  readonly reason: string;
  constructor(override readonly cause: unknown, readonly reply: string) {
    const reason = cause instanceof Error ? (cause.name === "ZodError" ? `schema: ${cause.message}` : cause.message) : String(cause);
    super(`MODEL_OUTPUT_REJECTED:${reason.slice(0, 200)}`);
    this.reason = reason.slice(0, 4_000);
    this.name = "ModelOutputRejectedError";
  }
}

function prepareModelInput(input: ModelActivityRequest<unknown>, config: RunConfig, testing?: TestingToolExtension) {
    const profile = Object.hasOwn(config.models, input.modelProfileId) ? config.models[input.modelProfileId] : undefined;
    if (profile === undefined) throw new Error(`UNKNOWN_MODEL_PROFILE:${input.modelProfileId}`);
    const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
    if (testing !== undefined && (config.mode !== "testing" || config.harness.mode !== "canonical" || input.activityId.endsWith("/discovery"))) throw new Error("TESTING_WRITE_HARNESS_MODE_REQUIRED");
    if (testing !== undefined && !profile.supports.tools) throw new Error("TESTING_WRITER_TOOLS_REQUIRED");
    const tools = profile.supports.tools ? [...SNAPSHOT_TOOLS, ...(testing?.definitions ?? [])] : [];
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
