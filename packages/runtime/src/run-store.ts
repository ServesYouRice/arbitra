import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActivityJournal, type JournalRecord } from "@arbitra/persistence/journal.js";
import { ArtifactStore } from "@arbitra/persistence/artifact-store.js";
import { loadJournal } from "@arbitra/persistence/journal-load.js";
import type { ActivityArtifactRef } from "@arbitra/core/activity.js";
import type { RunEvent, RunnerJournalPort, RunnerJournalRecord } from "@arbitra/core/runner/events.js";
import { isRunEvent } from "@arbitra/core/runner/events.js";
import type { RunDefinitionStore, StoredRunDefinition } from "@arbitra/core/runner/workflow-runner.js";

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

export class RunStore {
  readonly runId: string;
  readonly directory: string;
  readonly artifacts: ArtifactStore;

  readonly #journal: ActivityJournal;
  readonly #events: string;
  readonly #index: string;
  readonly #definition: string;
  readonly #journalPath: string;
  // The artifact index is a read-modify-write over one file, and the graph dispatches
  // sibling nodes concurrently, so publishes are serialised through this chain. Without
  // it two auditors finishing together each write an index missing the other's entry.
  #indexWrites: Promise<unknown> = Promise.resolve();

  constructor(rootDirectory: string, runId: string) {
    this.runId = runId;
    this.directory = join(rootDirectory, runId);
    this.#journalPath = join(this.directory, "journal.jsonl");
    this.#journal = new ActivityJournal(this.#journalPath);
    this.#events = join(this.directory, "events.jsonl");
    this.#index = join(this.directory, "artifacts.json");
    this.#definition = join(this.directory, "definition.json");
    this.artifacts = new ArtifactStore(this.directory);
  }

  /** The runner's single journal port, splitting activity records from run events. */
  journalPort(): RunnerJournalPort {
    return {
      append: async (record: RunnerJournalRecord, durability: "cheap" | "expensive" = "cheap"): Promise<void> => {
        if (isRunEvent(record)) await this.appendEvent(record);
        else await this.#journal.append(record as JournalRecord, durability);
      },
    };
  }

  async appendEvent(event: RunEvent): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.#events, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  async loadEvents(): Promise<readonly RunEvent[]> {
    const text = await readOptional(this.#events);
    if (text === null) return [];
    return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as RunEvent);
  }

  /** Activity records only; the runner replays completed activities from these. */
  async loadRecords(): Promise<readonly RunnerJournalRecord[]> {
    const { records } = await loadJournal(this.#journalPath);
    return records as readonly RunnerJournalRecord[];
  }

  definitions(): RunDefinitionStore {
    return {
      save: async (_runId: string, definition: StoredRunDefinition): Promise<void> => {
        await mkdir(this.directory, { recursive: true });
        await writeFile(this.#definition, JSON.stringify(definition, null, 2), "utf8");
      },
      load: async (): Promise<StoredRunDefinition> => {
        const text = await readOptional(this.#definition);
        if (text === null) throw new Error(`RUN_DEFINITION_ABSENT:${this.runId}`);
        return JSON.parse(text) as StoredRunDefinition;
      },
    };
  }

  /**
   * Publish a named artifact. The content-addressed store has no notion of a kind, and
   * the UI addresses artifacts by kind, so the mapping is recorded alongside it.
   */
  async publish(kind: string, value: unknown, nodeId: string | null = null): Promise<ArtifactDescriptor> {
    const ref = await this.artifacts.put(value, "json", { durability: "expensive" });
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
      await writeFile(this.#index, JSON.stringify([...existing, descriptor], null, 2), "utf8");
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
    return entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
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
