import { mkdir, open, readFile, readdir, rename, truncate, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ActivityJournal, type JournalRecord } from "@arbitra/persistence/journal.js";
import { ArtifactStore } from "@arbitra/persistence/artifact-store.js";
import { loadJournal } from "@arbitra/persistence/journal-load.js";
import type { ActivityArtifactRef } from "@arbitra/core/activity.js";
import type { RunEvent, RunnerJournalPort, RunnerJournalRecord } from "@arbitra/core/runner/events.js";
import { isRunEvent } from "@arbitra/core/runner/events.js";
import type { RunDefinitionStore, StoredRunDefinition } from "@arbitra/core/runner/workflow-runner.js";
import { runScopeSchema, type RunScope } from "@arbitra/schemas/config.js";
import { redactSecrets } from "@arbitra/security/redaction";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Everything one run owns on disk, under `<root>/<runId>/`.
 *
 * The activity journal and the run-event log are separate files on purpose:
 * `ActivityJournal` validates every record as an activity record, so the runner's
 * `run_transition` / `node_dispatched` / `node_completed` events cannot go through it.
 * The runner appends both kinds through one port, and this splits them back apart.
 */
export interface ArtifactDescriptor {
  readonly artifactId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly redacted: true;
  readonly nodeId: string | null;
  readonly ref: ActivityArtifactRef;
}

export interface StoredRunContext {
  readonly repository: string;
  readonly repositoryDigest: string;
  readonly scope: RunScope;
  readonly replaySourceRunId?: string;
  readonly consensusPolicy: "full" | "risk_weighted" | "minimal";
  readonly maximumRounds: number;
  readonly criticEnabled: boolean;
}

export class RunStore {
  readonly runId: string;
  readonly directory: string;
  readonly artifacts: ArtifactStore;

  readonly #journal: ActivityJournal;
  readonly #events: string;
  readonly #index: string;
  readonly #definition: string;
  readonly #context: string;
  readonly #journalPath: string;
  // The artifact index is a read-modify-write over one file, and the graph dispatches
  // sibling nodes concurrently, so publishes are serialised through this chain. Without
  // it two auditors finishing together each write an index missing the other's entry.
  #indexWrites: Promise<unknown> = Promise.resolve();
  #eventWrites: Promise<unknown> = Promise.resolve();
  #eventsReady = false;

  constructor(rootDirectory: string, runId: string) {
    if (!RUN_ID_PATTERN.test(runId)) throw new TypeError("INVALID_RUN_ID");
    this.runId = runId;
    this.directory = join(rootDirectory, runId);
    this.#journalPath = join(this.directory, "journal.jsonl");
    this.#journal = new ActivityJournal(this.#journalPath);
    this.#events = join(this.directory, "events.jsonl");
    this.#index = join(this.directory, "artifacts.json");
    this.#definition = join(this.directory, "definition.json");
    this.#context = join(this.directory, "context.json");
    this.artifacts = new ArtifactStore(this.directory);
  }

  /** The runner's single journal port, splitting activity records from run events. */
  journalPort(): RunnerJournalPort {
    return {
      append: async (record: RunnerJournalRecord, durability: "cheap" | "expensive" = "cheap"): Promise<void> => {
        if (isRunEvent(record)) await this.appendEvent(record, durability);
        else await this.#journal.append(record as JournalRecord, durability);
      },
    };
  }

  async appendEvent(event: RunEvent, durability: "cheap" | "expensive" = "cheap"): Promise<void> {
    if (!isRunEvent(event) || event.runId !== this.runId) throw new Error(`INVALID_RUN_EVENT:${this.runId}`);
    const write = this.#eventWrites.then(async () => {
      await mkdir(this.directory, { recursive: true });
      if (!this.#eventsReady) {
        const existing = await readOptional(this.#events);
        if (existing !== null && !existing.endsWith("\n")) await truncate(this.#events, Buffer.byteLength(existing.slice(0, existing.lastIndexOf("\n") + 1), "utf8"));
        this.#eventsReady = true;
      }
      const file = await open(this.#events, "a");
      try { await file.writeFile(`${JSON.stringify(event)}\n`, "utf8"); if (durability === "expensive") await file.sync(); }
      finally { await file.close(); }
    });
    this.#eventWrites = write.catch(() => undefined);
    await write;
  }

  async loadEvents(): Promise<readonly RunEvent[]> {
    const text = await readOptional(this.#events);
    if (text === null) return [];
    // A reader can race an append, and a crashed writer can leave an incomplete tail.
    // Only newline-terminated records are committed to the public event sequence.
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter((line) => line.length > 0).map((line, index) => {
      const parsed: unknown = JSON.parse(line);
      if (!isRunEvent(parsed) || parsed.runId !== this.runId) throw new Error(`INVALID_RUN_EVENT:${this.runId}:${index + 1}`);
      return parsed;
    });
  }

  /** Activity records only; the runner replays completed activities from these. */
  async loadRecords(): Promise<readonly RunnerJournalRecord[]> {
    const { records } = await loadJournal(this.#journalPath);
    return records as readonly RunnerJournalRecord[];
  }

  definitions(): RunDefinitionStore {
    return {
      save: async (runId: string, definition: StoredRunDefinition): Promise<void> => {
        if (runId !== this.runId || definition.config.runId !== this.runId) throw new Error(`RUN_DEFINITION_ID_MISMATCH:${this.runId}`);
        await mkdir(this.directory, { recursive: true });
        await atomicJson(this.#definition, definition);
      },
      load: async (runId: string): Promise<StoredRunDefinition> => {
        if (runId !== this.runId) throw new Error(`RUN_DEFINITION_ID_MISMATCH:${this.runId}`);
        const text = await readOptional(this.#definition);
        if (text === null) throw new Error(`RUN_DEFINITION_ABSENT:${this.runId}`);
        const definition = JSON.parse(text) as StoredRunDefinition;
        if (definition.config?.runId !== this.runId) throw new Error(`RUN_DEFINITION_ID_MISMATCH:${this.runId}`);
        return definition;
      },
    };
  }

  async saveContext(context: StoredRunContext): Promise<void> {
    validateContext(context);
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.#context, JSON.stringify(context, null, 2), { encoding: "utf8", flag: "wx" });
  }

  async loadContext(): Promise<StoredRunContext> {
    const text = await readOptional(this.#context);
    if (text === null) throw new Error(`RUN_CONTEXT_ABSENT:${this.runId}`);
    const context: unknown = JSON.parse(text);
    validateContext(context);
    return Object.freeze(context);
  }

  /**
   * Publish a named artifact. The content-addressed store has no notion of a kind, and
   * the UI addresses artifacts by kind, so the mapping is recorded alongside it.
   */
  async publish(kind: string, value: unknown, nodeId: string | null = null): Promise<ArtifactDescriptor> {
    const encoded = JSON.stringify(value, (_key, child: unknown) => typeof child === "string" ? redactSecrets(child).text : child);
    if (encoded === undefined) throw new Error("ARTIFACT_VALUE_NOT_JSON");
    const redacted: unknown = JSON.parse(redactSecrets(encoded).text);
    const ref = await this.artifacts.put(redacted, "json", { durability: "expensive" });
    const descriptor: ArtifactDescriptor = Object.freeze({
      artifactId: `${kind}-${ref.hash.slice(0, 16)}`,
      kind,
      mediaType: "application/json",
      bytes: ref.byteLength,
      redacted: true,
      nodeId,
      ref,
    });
    const write = this.#indexWrites.then(async () => {
      const existing = (await this.listArtifacts()).filter((item) => item.kind !== kind);
      await mkdir(this.directory, { recursive: true });
      await atomicJson(this.#index, [...existing, descriptor]);
    });
    this.#indexWrites = write.catch(() => undefined);
    await write;
    return descriptor;
  }

  async listArtifacts(): Promise<readonly ArtifactDescriptor[]> {
    const text = await readOptional(this.#index);
    return text === null ? [] : JSON.parse(text) as readonly ArtifactDescriptor[];
  }

  async readArtifact(artifactId: string): Promise<{ readonly descriptor: ArtifactDescriptor; readonly content: string }> {
    const descriptor = (await this.listArtifacts()).find((item) => item.artifactId === artifactId);
    if (descriptor === undefined) throw new Error(`ARTIFACT_ABSENT:${artifactId}`);
    const value = await this.artifacts.get<unknown>(descriptor.ref);
    return { descriptor, content: JSON.stringify(value) };
  }
}

export async function listRunIds(rootDirectory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name)).map(({ name }) => name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateContext(value: unknown): asserts value is StoredRunContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_RUN_CONTEXT");
  const context = value as Record<string, unknown>;
  if (typeof context["repository"] !== "string" || !isAbsolute(context["repository"])) throw new Error("INVALID_RUN_CONTEXT_REPOSITORY");
  if (typeof context["repositoryDigest"] !== "string" || !/^[a-f0-9]{64}$/u.test(context["repositoryDigest"])) throw new Error("INVALID_RUN_CONTEXT_DIGEST");
  runScopeSchema.parse(context["scope"]);
  if (context["replaySourceRunId"] !== undefined && (typeof context["replaySourceRunId"] !== "string" || !RUN_ID_PATTERN.test(context["replaySourceRunId"]))) throw new Error("INVALID_REPLAY_SOURCE_RUN_ID");
  if (context["consensusPolicy"] !== "full" && context["consensusPolicy"] !== "risk_weighted" && context["consensusPolicy"] !== "minimal") throw new Error("INVALID_RUN_CONTEXT_POLICY");
  if (!Number.isSafeInteger(context["maximumRounds"]) || (context["maximumRounds"] as number) < 0 || (context["maximumRounds"] as number) > 3) throw new Error("INVALID_RUN_CONTEXT_ROUNDS");
  if (typeof context["criticEnabled"] !== "boolean") throw new Error("INVALID_RUN_CONTEXT_CRITIC");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w");
  try { await file.writeFile(JSON.stringify(value, null, 2), "utf8"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}
