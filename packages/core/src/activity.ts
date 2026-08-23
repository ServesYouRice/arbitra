export interface ActivityArtifactRef {
  readonly hash: string;
  readonly byteLength: number;
  readonly extension: string;
  readonly relativePath: string;
}

export type ActivityRecord =
  | { readonly t: "attempt_start"; readonly id: string; readonly attempt: number; readonly providerRequestId?: string }
  | { readonly t: "attempt_error"; readonly id: string; readonly attempt: number; readonly error: string }
  | { readonly t: "end"; readonly id: string; readonly attempt: number; readonly ok: true; readonly artifact: ActivityArtifactRef; readonly usage: null };

export interface ActivityJournalPort {
  append(record: ActivityRecord, durability?: "cheap" | "expensive"): Promise<void>;
}

export interface ActivityArtifactStorePort {
  put(value: unknown, extension: string, options?: { readonly durability?: "cheap" | "expensive" }): Promise<ActivityArtifactRef>;
  get<T>(ref: ActivityArtifactRef): Promise<T>;
}

export interface ActivityRuntimeOptions {
  readonly journal: ActivityJournalPort;
  readonly artifacts: ActivityArtifactStorePort;
  readonly completed?: ReadonlyMap<string, ActivityArtifactRef>;
  readonly attempts?: ReadonlyMap<string, number>;
}

export interface RunActivityOptions {
  readonly durability?: "cheap" | "expensive";
  readonly extension?: string;
  readonly providerRequestId?: string;
}

export class ActivityRuntime {
  readonly #artifacts: ActivityArtifactStorePort;
  readonly #attempts: Map<string, number>;
  readonly #completed: Map<string, ActivityArtifactRef>;
  readonly #journal: ActivityJournalPort;

  constructor(options: ActivityRuntimeOptions) {
    this.#journal = options.journal;
    this.#artifacts = options.artifacts;
    this.#completed = new Map(options.completed);
    this.#attempts = new Map(options.attempts);
  }

  async activity<T>(id: string, fn: () => Promise<T>, options: RunActivityOptions = {}): Promise<T> {
    const stored = this.#completed.get(id);
    if (stored !== undefined) {
      try {
        return await this.#artifacts.get<T>(stored);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        this.#completed.delete(id);
      }
    }

    const attempt = (this.#attempts.get(id) ?? 0) + 1;
    this.#attempts.set(id, attempt);
    await this.#journal.append({
      t: "attempt_start",
      id,
      attempt,
      ...(options.providerRequestId === undefined ? {} : { providerRequestId: options.providerRequestId }),
    });

    try {
      const result = await fn();
      const durability = options.durability ?? "expensive";
      const artifact = await this.#artifacts.put(result, options.extension ?? "json", { durability });
      await this.#journal.append(
        { t: "end", id, attempt, ok: true, artifact, usage: null },
        durability,
      );
      this.#completed.set(id, artifact);
      return result;
    } catch (error) {
      await this.#journal.append({
        t: "attempt_error",
        id,
        attempt,
        error: describeError(error),
      });
      throw error;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
