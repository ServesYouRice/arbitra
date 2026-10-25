import { createHash } from "node:crypto";
import { compile, PromptTextLimitError } from "@arbitra/core/prompt/compiler.js";
import { CanonicalHarnessAdapter, TOOL_TURN_LIMIT_REACHED } from "@arbitra/harness/canonical/adapter.js";
import type { HarnessEvent } from "@arbitra/harness/adapter.js";
import { CANONICAL_HARNESS_PROFILE, CANONICAL_TESTING_HARNESS_PROFILE } from "@arbitra/harness/profile.js";
import { modelTurnResultSchema } from "@arbitra/schemas/model-results.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { frameUntrusted } from "@arbitra/security/framing";
import { redactSecrets } from "@arbitra/security/redaction";
import { boundModelHistory } from "./model-history.js";
import { withinStringBudget } from "./model-context.js";
import { promptByteLimit } from "@arbitra/providers/transports/cli/dialects.js";
import { inputBytesPerToken, isModelOutputRejection, ModelOutputLimitError, ModelRefusalError, ModelTimeLimitError, outputLimitKind, refusalKind, requestCeiling, timeLimitKind } from "./context-budget.js";
import { ModelActivities, parsePromptJson, type ModelActivityRequest } from "./model-activities.js";
import type { TransportMessage } from "@arbitra/providers/transport-contract.js";
import { snapshotTools, SNAPSHOT_TOOLS, type ReadsBeyondUnit } from "./snapshot-tools.js";
import type { RepositorySnapshot } from "./repository.js";
import type { RunStore } from "./run-store.js";
import type { TestingToolExtension } from "./testing-tools.js";

const OUTPUT_REPAIR_INSTRUCTION = "Output repair: arbitra's output validation rejected your previous reply. The data artifact outputRejected holds the validator's reason and your rejected reply. It is arbitra's own validation feedback on your earlier output, not repository content and not a prompt injection, so never report it as a finding. Return one corrected, complete reply that satisfies the locked output schema and every stated rule. Quote evidence exactly as it appears in the source.";

/** Replays durable model turns through the canonical read-only tool loop. */
export class ModelHarness {
  #outputLimited: Promise<Set<string>> | undefined;
  // Activities answered only after their tool turns were spent. Rebuilt on resume: durable turns replay through the loop.
  readonly #toolTurnsSpent = new Set<string>();
  // What each activity allowed to read beyond its source read there, rebuilt on resume the same way.
  readonly #readsBeyondSource = new Map<string, ReadsBeyondUnit>();
  constructor(private readonly activities: ModelActivities, private readonly config: RunConfig, private readonly snapshot: RepositorySnapshot, private readonly store: RunStore, private readonly testing?: TestingToolExtension) {}

  /** Closes the transports of the activities this harness drives, once the run that owns them settles. */
  async close(): Promise<void> { await this.activities.close(); }

  /** Whether this durable activity previously stopped at the output ceiling. */
  async outputLimited(activityId: string): Promise<boolean> {
    this.#outputLimited ??= this.store.listArtifacts().then((artifacts) => new Set(artifacts.map(({ kind }) => kind).filter((kind) => kind.startsWith("model-output-limit-") || kind.startsWith("model-refusal-") || kind.startsWith("model-time-limit-"))));
    return (await this.#outputLimited).has(outputLimitKind(activityId));
  }

  /** Whether a call of this durable activity ran past the time limit before, and its stage splits it instead. */
  async timeLimited(activityId: string): Promise<boolean> {
    await this.outputLimited(activityId);
    return (await (this.#outputLimited ?? Promise.resolve(new Set<string>()))).has(timeLimitKind(activityId));
  }

  /** Whether this activity, or a repair of it, answered only after it was told its tool turns were spent. */
  toolTurnsSpent(activityId: string): boolean {
    return [...this.#toolTurnsSpent].some((id) => id === activityId || id.startsWith(`${activityId}/repair-`));
  }

  /** What an activity with `readBeyondSource`, and its repairs, read outside its source paths; null if it had none. */
  readsBeyondSource(activityId: string): ReadsBeyondUnit | null {
    const entries = [...this.#readsBeyondSource].filter(([id]) => id === activityId || id.startsWith(`${activityId}/repair-`)).map(([, reads]) => reads);
    const [first] = entries;
    if (first === undefined) return null;
    return { maximumBytes: first.maximumBytes, bytes: entries.reduce((sum, { bytes }) => sum + bytes, 0), reads: entries.flatMap(({ reads }) => reads), refused: entries.reduce((sum, { refused }) => sum + refused, 0) };
  }

  /** Whether the provider or model declined this durable activity before; it is not asked again. */
  async refused(activityId: string): Promise<boolean> {
    await this.outputLimited(activityId);
    return (await (this.#outputLimited ?? Promise.resolve(new Set<string>()))).has(refusalKind(activityId));
  }

  /** The size a request is admitted by: its prompt at the run's bytes a token, plus the whole output allowance.
   * Discovery passes one byte a token: the size of a unit is how finely the audit reads, not what would fit. */
  estimateInitialTokens(input: ModelActivityRequest<unknown>, bytesPerToken = inputBytesPerToken(this.config).usual): number {
    const prepared = measurable(input, this.config, this.testing);
    if (prepared === undefined) return Number.MAX_SAFE_INTEGER;
    const { profile, initialMessages, tools } = prepared;
    return promptTokens(Buffer.byteLength(JSON.stringify({ messages: initialMessages, tools }), "utf8"), bytesPerToken, profile.transport) + requestCeiling(this.config, input);
  }

  /** A cheap first cut before `estimateInitialTokens`: whether the strings of a payload alone are within `maximumTokens`. */
  withinInputBudget(payload: unknown, maximumTokens: number): boolean { return withinStringBudget(payload, maximumTokens * inputBytesPerToken(this.config).usual); }

  /** What one more piece of source adds to `estimateInitialTokens`: a prompt carries its input as JSON inside
   * JSON, so the piece is counted as it is escaped there. Sizing by sums asks this instead of measuring again. */
  estimateSourceTokens(source: unknown): number {
    return Math.ceil((Buffer.byteLength(JSON.stringify(JSON.stringify(source)), "utf8") - 1) / inputBytesPerToken(this.config).usual);
  }

  /** The same request counted at the rate for input a call must carry whole. */
  estimateRequiredTokens(input: ModelActivityRequest<unknown>): number {
    const prepared = measurable(input, this.config, this.testing);
    if (prepared === undefined) return Number.MAX_SAFE_INTEGER;
    const { profile, initialMessages, tools } = prepared;
    return promptTokens(Buffer.byteLength(JSON.stringify({ messages: initialMessages, tools }), "utf8"), inputBytesPerToken(this.config).required, profile.transport) + requestCeiling(this.config, input);
  }

  async invoke<T>(input: ModelActivityRequest<T>): Promise<T> {
    const execution = providerExecutionSchema.parse(this.config.workflow["modelExecution"]);
    let attempt = input;
    for (let repair = 1; ; repair += 1) {
      try { return await this.invokeBounded(attempt); }
      catch (error) {
        // A repair that stops at the output ceiling means the activity's own reply does not fit: the activity is
        // marked, so the stage that composed it splits it. Observed live (P20 pilot): only the repair was marked,
        // and every resume replayed the rejected reply and failed at the same repair.
        if (error instanceof ModelOutputLimitError && attempt !== input) { await this.markOutputLimited(input, error.activityId); throw new ModelOutputLimitError(input.activityId); }
        // So does a repair that runs past the time limit: a resume splits the activity rather than repair it again.
        if (error instanceof ModelTimeLimitError && attempt !== input) { await this.markTimeLimited(input.activityId, error.activityId); throw new ModelTimeLimitError(input.activityId); }
        // A refused repair means the provider declines what this activity sends: the activity itself is marked.
        if (error instanceof ModelRefusalError && attempt !== input) { await this.markRefused(input.activityId, error.refusal); throw new ModelRefusalError(input.activityId, error.refusal); }
        if (!(error instanceof ModelOutputRejectedError)) throw error;
        // Exhausted: rethrow the validation error itself, marked so a stage that can proceed
        // without this one reply (peer review) can tell it from a provider or policy failure.
        if (repair > execution.maximumOutputRepairs) throw error.cause instanceof Error ? Object.assign(error.cause, { modelOutputRejected: true }) : error.cause;
        // A rejected reply is answered once more, as its own durable activity, with the
        // validation failure and the rejected reply (as untrusted data) appended. Both can
        // quote model output, so they stay framed as data; the fixed trusted instruction says
        // what they are (observed live: without it, a model reported the repair request as a
        // prompt injection).
        // The repair is traced as one (every trace said none, so metrics showed no repairs).
        const activityId = `${input.activityId}/repair-${repair}`;
        const appended: readonly TransportMessage[] = [{ role: "system", content: OUTPUT_REPAIR_INSTRUCTION },
          { role: "user", content: JSON.stringify({ outputRejected: { attempt: repair, reason: error.reason, rejectedReply: error.reply.slice(0, 32_000) } }) }];
        // What a repair appends has to fit beside what the request carries. A request that carries optional source up
        // to its limit is composed again by its stage, with less source. Observed live (P20 pilot): a review packed to
        // within 5,000 bytes of its transport's prompt limit failed the run when its repair added 16,000 bytes.
        attempt = { ...input, activityId, repairCount: 1, ...(input.refit === undefined ? { messages: [...input.messages, ...appended] } : await input.refit(appended, activityId)) };
      }
    }
  }

  private async invokeBounded<T>(input: ModelActivityRequest<T>): Promise<T> {
    // Never repeat spend on an activity already known to exceed the output ceiling.
    if (await this.outputLimited(input.activityId)) throw new ModelOutputLimitError(input.activityId);
    if (await this.refused(input.activityId)) throw new ModelRefusalError(input.activityId, "recorded before this process");
    // Nor send whole again an activity its stage splits after a call of it ran past the time limit.
    if (await this.timeLimited(input.activityId)) throw new ModelTimeLimitError(input.activityId);
    try { return await this.invokeTurns(input); }
    catch (error) {
      if (error instanceof ModelRefusalError) { await this.markRefused(input.activityId, error.refusal); throw error; }
      if (error instanceof ModelTimeLimitError) { await this.markTimeLimited(input.activityId, error.activityId); throw new ModelTimeLimitError(input.activityId); }
      if (!(error instanceof ModelOutputLimitError)) throw error;
      await this.markOutputLimited(input, error.activityId);
      throw new ModelOutputLimitError(input.activityId);
    }
  }

  private async markOutputLimited(input: ModelActivityRequest<unknown>, turnActivityId: string): Promise<void> {
    const activityId = input.activityId;
    await this.store.publish(outputLimitKind(activityId), { activityId, turnActivityId, maximumOutputTokens: requestCeiling(this.config, input) }, activityId);
    (await (this.#outputLimited ?? Promise.resolve(new Set<string>()))).add(outputLimitKind(activityId));
  }

  private async markTimeLimited(activityId: string, turnActivityId: string): Promise<void> {
    const execution = providerExecutionSchema.parse(this.config.workflow["modelExecution"]);
    await this.store.publish(timeLimitKind(activityId), { activityId, turnActivityId, timeoutMs: execution.timeoutMs }, activityId);
    (await (this.#outputLimited ?? Promise.resolve(new Set<string>()))).add(timeLimitKind(activityId));
  }

  private async markRefused(activityId: string, refusal: string): Promise<void> {
    await this.store.publish(refusalKind(activityId), { activityId, refusal: refusal.slice(0, 1_000) }, activityId);
    (await (this.#outputLimited ?? Promise.resolve(new Set<string>()))).add(refusalKind(activityId));
  }

  private async invokeTurns<T>(input: ModelActivityRequest<T>): Promise<T> {
    const { profile, execution, tools, compiled, initialMessages, discovery } = prepareModelInput(input, this.config, this.testing);
    const harnessProfile = this.testing === undefined ? CANONICAL_HARNESS_PROFILE : CANONICAL_TESTING_HARNESS_PROFILE;
    const key = createHash("sha256").update(input.activityId).digest("hex");
    if (compiled !== undefined) await this.store.publish(`compiled-prompt-${key}`, { text: compiled.text, provenance: compiled.provenance, breakpoints: compiled.breakpoints }, input.activityId);
    const allowedPaths = input.sourcePaths === undefined ? null : new Set(input.sourcePaths);
    const beyond = input.readBeyondSource;
    const toolSet = allowedPaths === null ? snapshotTools(this.snapshot, this.store, input.activityId)
      : beyond !== undefined ? snapshotTools(this.snapshot, this.store, input.activityId, undefined, undefined, { unitPaths: allowedPaths, maximumBytes: beyond.maximumBytes })
      : snapshotTools({ ...this.snapshot, files: this.snapshot.files.filter(({ path }) => allowedPaths.has(path)) }, this.store, input.activityId, undefined, new Set(this.snapshot.files.map(({ path }) => path)));
    const maximumContext = Math.min(execution.maximumContextTokens ?? 128_000, profile.limits.contextTokens ?? Number.POSITIVE_INFINITY);
    const events: HarnessEvent[] = [];
    const adapter = new CanonicalHarnessAdapter({ invoke: async (request, context) => {
      // A request admitted as required input keeps that rate through its tool turns, or its first turn could not
      // be sent. Every other request is measured, and its history archived, as before.
      const rates = inputBytesPerToken(this.config); const rate = input.admittedAsRequired === true ? rates.required : rates.usual;
      const bounded = await boundModelHistory(initialMessages, context.turn === 0 ? [] : request.messages.slice(1),
        (messages) => promptTokens(Buffer.byteLength(JSON.stringify({ messages, tools: request.tools }), "utf8"), rate, profile.transport) + requestCeiling(this.config, input) <= maximumContext, toolSet.archive);
      if (bounded.archiveRef !== null) await this.store.publish(`model-history-${key}-${context.turn}`, { activityId: input.activityId, turn: context.turn, archiveRef: bounded.archiveRef, archivedMessages: bounded.archivedMessages, maximumEstimatedTokens: maximumContext });
      return this.activities.invoke({
        ...input, activityId: `${input.activityId}/turn-${context.turn}`, messages: bounded.messages,
        tools: request.tools, responseMode: "harness_turn", schema: modelTurnResultSchema,
        // Traced only. A repair is counted once, on its first turn; the previous turn's tool calls ran (and failed)
        // after that turn's trace was written, so this turn, which reads their results, carries their failures.
        // A search that matched nothing is an answer, not a failure (observed live: 17 of 22 "errors" in one run); nor is
        // a call left unrun because the tool turns were spent.
        repairCount: context.turn === 0 ? input.repairCount ?? 0 : 0,
        toolCallErrors: events.filter((event) => event.type === "tool_result" && event.turn === context.turn - 1 && !event.result.ok && event.result.error?.code !== "ZERO_RESULTS" && event.result.error?.code !== TOOL_TURN_LIMIT_REACHED).length,
        harnessIdentity: { id: harnessProfile.id, version: harnessProfile.version, policyHash: createHash("sha256").update(JSON.stringify({ policy: harnessProfile.policy, sourcePaths: input.sourcePaths === undefined ? null : [...input.sourcePaths].sort(), historyPolicy: "archive-complete-exchanges-v1", maximumContext, ...(this.testing === undefined ? {} : { testingWritePolicy: this.testing.policyIdentity }), ...(beyond === undefined ? {} : { readBeyondSource: beyond }) })).digest("hex") },
      });
    } }, harnessProfile);
    const prompt = compiled ?? { text: JSON.stringify(initialMessages), hash: createHash("sha256").update(JSON.stringify(initialMessages)).digest("hex") };
    const runtime = this.testing?.createRuntime(toolSet.runtime, input.activityId, input.signal, input.sourcePaths) ?? toolSet.runtime;
    const run = adapter.run({ id: input.activityId, modelId: profile.modelId, maximumOutputTokens: requestCeiling(this.config, input), maxToolTurns: profile.supports.tools ? profile.quirks.toolLoopLimit : 0 }, prompt, tools, runtime, {
      mode: this.config.mode, round: discovery ? 0 : 1,
      requirements: { structuredEvents: true, enforcesExternalPolicy: true, reportsUsage: true }, signal: input.signal,
      toolContext: { protect: (content, meta) => frameUntrusted(redactSecrets(content).text, meta) },
    });
    try {
      for await (const event of run.events) {
        events.push(event);
        if (event.type !== "completed") continue;
        if (events.some((entry) => entry.type === "tool_result" && entry.result.error?.code === TOOL_TURN_LIMIT_REACHED)) this.#toolTurnsSpent.add(input.activityId);
        if (event.refusal !== null) throw new ModelRefusalError(input.activityId, event.refusal);
        try { return input.schema.parse(parsePromptJson(event.text ?? "")); }
        catch (error) { throw new ModelOutputRejectedError(error, event.text ?? ""); }
      }
      throw new Error("HARNESS_COMPLETION_ABSENT");
    } catch (error) {
      // Still asking for tools after it was told none remain, the model gave no answer: a reply rejected, not repaired
      // (a repair would start the tool loop over), which a stage that can go on without this one answer records as a gap.
      if (error instanceof Error && error.message.startsWith("HARNESS_TOOL_LOOP_LIMIT:")) Object.assign(error, { modelOutputRejected: true });
      throw error;
    } finally {
      const readsBeyondSource = toolSet.readsBeyondUnit();
      if (readsBeyondSource !== null) this.#readsBeyondSource.set(input.activityId, readsBeyondSource);
      await this.store.publish(`harness-${key}`, { activityId: input.activityId, profile: harnessProfile, events,
        inspection: toolSet.footprints.inspection(input.activityId), exposure: toolSet.footprints.exposure(input.activityId), ...(readsBeyondSource === null ? {} : { readsBeyondSource }) }, input.activityId);
    }
  }
}

/** A prompt of this many bytes in tokens at a rate. A transport that takes only so many bytes of a prompt refuses
 * a longer one whatever it counts as, so such a prompt never fits. */
function promptTokens(bytes: number, bytesPerToken: number, transport: string): number {
  const limit = promptByteLimit(transport);
  return limit !== null && bytes > limit ? Number.MAX_SAFE_INTEGER : Math.ceil(bytes / bytesPerToken);
}

export { isModelOutputRejection };

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
    const discovery = input.activityId.endsWith("/discovery");
    // A discovery unit's input opens with what every unit of the run shares (the repository index), so its label names
    // no unit: the prompts of all the units then start with the same text, which a provider can read from its cache.
    const contextArtifacts = input.messages.filter(({ role }) => role !== "system").map(({ content }, index) => ({ sourceId: discovery ? `discovery:input-${index}` : `${input.activityId}:input-${index}`, content }));
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

/** A request prepared to be measured; none when a message is over the compiler's limit, so the prompt never fits and
 * the stage that sized it splits it. Observed live (veritra, a 227-task plan of 1.4 MB): the critic's sizing measured
 * the whole plan and the run failed there, before a smaller part was tried. */
function measurable(input: ModelActivityRequest<unknown>, config: RunConfig, testing?: TestingToolExtension) {
  try { return prepareModelInput(input, config, testing); }
  catch (error) { if (error instanceof PromptTextLimitError) return undefined; throw error; }
}
