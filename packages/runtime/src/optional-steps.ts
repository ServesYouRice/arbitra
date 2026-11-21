import type { OptionalStep } from "@arbitra/core/runner/events.js";
import type { ProviderUsageLimitError } from "@arbitra/providers/runtime.js";
import type { RunConfig } from "@arbitra/schemas/config.js";
import { providerExecutionSchema } from "@arbitra/schemas/provider-execution.js";
import type { RunStore } from "./run-store.js";

/** The artifact that holds the models a run found out of their allowance, and where its optional steps went instead. */
export const OPTIONAL_STEPS_KIND = "optional-steps";

/** One optional step leaving a model whose allowance was out, as the run records it and its `optional_step_limited` event says it. */
export interface OptionalStepMove {
  readonly at: string; readonly step: OptionalStep; readonly from: string;
  /** The profile the step went to; null when the run went on without the step. */
  readonly to: string | null;
  readonly resetsAt?: string; readonly detail?: string;
}

export interface OptionalStepState {
  readonly schemaVersion: 1;
  /** The profiles found out of their usage allowance, when, and until when (null: the provider did not say). */
  readonly limited: Readonly<Record<string, { readonly at: string; readonly until: string | null }>>;
  readonly moves: readonly OptionalStepMove[];
}

const EMPTY: OptionalStepState = Object.freeze({ schemaVersion: 1, limited: {}, moves: [] });

/**
 * The owner's rule (November 2026): an optional step never holds a core stage on another vendor's usage window. The
 * second opinion before a severe rejection, the variant search, a finder the run can go on without and the plan critic
 * are optional; finding with the two finders the roles need, checking, merging and the plan are core. When an optional
 * step's model is out of its allowance, the run waits only as it would for any model (a subscription's limit that
 * resets within `fallbackWaitMs`, ModelRoutes.waits); else the profile's fallback answers when it has one
 * (ModelRoutes); else the step goes to another model where it has a stand-in, or the run goes on without it. Each
 * move is recorded in the run (this artifact) and as an `optional_step_limited` event, once for each step, model and
 * stand-in, and a model found out is not asked again until its reset, so a resume keeps the decision.
 *
 * Observed live (a real-project audit, November 11, 2026): Opus had answered every verification question but one, whose second
 * opinion was on GPT-6.1 Sol through Codex; Codex's five-hour window was used up, and the run waited 3 h 04 on that one
 * question while the plan, on another login, could have run.
 */
export class OptionalSteps {
  #state: OptionalStepState | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /** Profiles found out with no reset given, in this process: a resume asks them again. */
  readonly #noReset = new Set<string>();

  /** `wait`: the run's `fallbackWaitMs`; a limit that resets within it is asked again, and the run waits for it as for any model. */
  constructor(private readonly store: RunStore, private readonly wait: number, private readonly now: () => number = Date.now) {}

  /**
   * Whether `profile` is known to be out of its allowance for longer than the run waits, and until when (null: no reset
   * was given, found in this process); undefined when it is not, so it is asked. A profile whose reset is near is asked again.
   */
  async limitedUntil(profile: string): Promise<string | null | undefined> {
    const entry = (await this.#serial(() => this.#load())).limited[profile];
    if (entry === undefined) return undefined;
    if (entry.until === null) return this.#noReset.has(profile) ? null : undefined;
    return this.now() + this.wait < Date.parse(entry.until) ? entry.until : undefined;
  }

  /** A call of `profile` met a usage limit the run does not wait for: it is not asked again until its reset. Returns the reset (ISO-8601), or null when none was given. */
  limited(profile: string, error: ProviderUsageLimitError): Promise<string | null> {
    return this.#serial(async () => {
      const until = resetOf(error, this.now());
      if (until === null) this.#noReset.add(profile);
      const state = await this.#load();
      await this.#save({ ...state, limited: { ...state.limited, [profile]: { at: new Date(this.now()).toISOString(), until } } });
      return until;
    });
  }

  /** `step` left `from` for `to` (null: the run went on without it). Recorded once for each step, model and stand-in. */
  moved(step: OptionalStep, from: string, to: string | null, detail?: string): Promise<void> {
    return this.#serial(async () => {
      const state = await this.#load();
      if (state.moves.some((move) => move.step === step && move.from === from && move.to === to)) return;
      const until = state.limited[from]?.until ?? null;
      const move: OptionalStepMove = { at: new Date(this.now()).toISOString(), step, from, to, ...(until === null ? {} : { resetsAt: until }), ...(detail === undefined ? {} : { detail: detail.slice(0, 300) }) };
      await this.#save({ ...state, moves: [...state.moves, move] });
      await this.store.appendEvent({ t: "optional_step_limited", runId: this.store.runId, ...move }, "expensive");
    });
  }

  /** The moves the run has recorded for a step. */
  async moves(step: OptionalStep): Promise<readonly OptionalStepMove[]> { return (await this.#serial(() => this.#load())).moves.filter((move) => move.step === step); }

  async #load(): Promise<OptionalStepState> {
    if (this.#state !== undefined) return this.#state;
    const artifact = (await this.store.listArtifacts()).find(({ kind }) => kind === OPTIONAL_STEPS_KIND);
    const stored = artifact === undefined ? null : JSON.parse((await this.store.readArtifact(artifact.artifactId)).content) as Partial<OptionalStepState>;
    this.#state = stored === null ? EMPTY : { ...EMPTY, ...stored, schemaVersion: 1 };
    return this.#state;
  }

  async #save(next: OptionalStepState): Promise<void> {
    this.#state = next;
    await this.store.publish(OPTIONAL_STEPS_KIND, next);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/** When a usage limit resets (ISO-8601): from the time the provider gave, else from the words of its reason, else null. */
export function resetOf(error: ProviderUsageLimitError, now: number): string | null {
  if (error.retryAfterMs !== null) return new Date(now + error.retryAfterMs).toISOString();
  const until = /\buntil (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/u.exec(error.message)?.[1];
  return until !== undefined && Number.isFinite(Date.parse(until)) ? new Date(Date.parse(until)).toISOString() : null;
}

/** A profile in the words a reason gives it: its model, its name in the run and its vendor ("gpt-6.1-sol (auditor-b, openai)"). */
export function profileWords(config: RunConfig, profile: string): string {
  const model = config.models[profile];
  return model === undefined ? profile : `${model.modelId} (${profile}, ${model.provider})`;
}

/** Why a step went without a model, in the words a person reads: "gpt-6.1-sol (auditor-b, openai) limited until 2026-11-11T12:17:00.000Z". */
export function limitedWords(config: RunConfig, profile: string, until: string | null): string {
  return `${profileWords(config, profile)} limited ${until === null ? "with no reset time given" : `until ${until}`}`;
}

const RANK: Readonly<Record<string, number>> = Object.freeze({ fast: 0, balanced: 1, frontier: 2 });

/**
 * The profiles that may answer a second opinion in place of `asked` once its allowance is out, in order: of another
 * vendor than `checker`, the model whose rejection the opinion checks, so the second look stays independent; on another
 * account than any model found out (`out`), since a CLI's window is its account's; at least as capable as `asked`;
 * and not a finder the run left out. The run's profiles are taken in the order of `preferred` (the critic, then the
 * finders), then the rest by name.
 */
export function secondOpinionStandIns(config: RunConfig, { asked, checker, out, preferred, leftOut }: { readonly asked: string; readonly checker: string; readonly out: ReadonlySet<string>; readonly preferred: readonly string[]; readonly leftOut: ReadonlySet<string> }): readonly string[] {
  const execution = providerExecutionSchema.parse(config.workflow["modelExecution"]);
  const vendor = config.models[checker]?.provider;
  const rank = RANK[config.models[asked]?.capabilityTier ?? "fast"] ?? 0;
  const accounts = new Set([...out, asked].map((id) => execution.modelEndpoints[id]));
  const ordered = [...new Set([...preferred, ...Object.keys(config.models).sort()])];
  return ordered.filter((id) => {
    const model = config.models[id];
    return model !== undefined && id !== asked && !out.has(id) && !leftOut.has(id) && model.provider !== vendor && (RANK[model.capabilityTier] ?? 0) >= rank && !accounts.has(execution.modelEndpoints[id]);
  });
}
