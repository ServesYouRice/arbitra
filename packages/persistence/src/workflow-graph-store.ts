import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArtifactStore, contentAddress, type ArtifactRef } from "./artifact-store.js";

/**
 * Durable, immutable storage for operator-authored workflow graphs.
 *
 * A graph body is stored once in a content-addressed artifact store, and its version is
 * that address: the SHA-256 of its canonical JSON. A version record (parent, save time and
 * the operator's explicit authorizations) is created at most once per graph version, by
 * an fsynced staging file hard-linked into place, so no writer in any process can replace
 * a saved version. Every read re-checks both the record and the body's content address.
 *
 * The store knows nothing about graph semantics. Callers validate before saving and again
 * before executing a stored version.
 */
export interface WorkflowGraphVersionRecord {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly version: string;
  readonly parentVersion: string | null;
  readonly savedAt: string;
  readonly authorizations: readonly string[];
  readonly graph: unknown;
}
export type WorkflowGraphVersionSummary = Omit<WorkflowGraphVersionRecord, "graph">;
export interface WorkflowGraphSummary { readonly graphId: string; readonly versions: readonly WorkflowGraphVersionSummary[] }

interface StoredVersion extends WorkflowGraphVersionSummary { readonly ref: ArtifactRef }

export const WORKFLOW_GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^[a-f0-9]{64}$/u;
let stagingSequence = 0;

export class WorkflowGraphStore {
  readonly #root: string;
  readonly #bodies: ArtifactStore;
  readonly #now: () => string;

  constructor(directory: string, options: { readonly now: () => string }) {
    this.#root = directory;
    this.#bodies = new ArtifactStore(directory);
    this.#now = options.now;
  }

  /** The version a graph would be stored under, computed without writing. */
  static versionOf(graph: unknown): string { return contentAddress(graph, "json").hash; }

  async save(input: { readonly graphId: string; readonly graph: unknown; readonly parentVersion: string | null; readonly authorizations: readonly string[] }): Promise<{ readonly record: WorkflowGraphVersionRecord; readonly created: boolean }> {
    assertGraphId(input.graphId);
    if (input.parentVersion !== null && await this.get(input.graphId, input.parentVersion) === null) throw Object.assign(new Error(`WORKFLOW_PARENT_VERSION_ABSENT:${input.graphId}:${input.parentVersion}`), { statusCode: 409 });
    const ref = await this.#bodies.put(input.graph, "json", { durability: "expensive" });
    const stored: StoredVersion = Object.freeze({
      schemaVersion: 1, graphId: input.graphId, version: ref.hash, parentVersion: input.parentVersion,
      savedAt: this.#now(), authorizations: Object.freeze([...new Set(input.authorizations)].sort()), ref,
    });
    const created = await createOnce(this.#recordPath(input.graphId, ref.hash), stored);
    const record = await this.get(input.graphId, ref.hash);
    if (record === null) throw new Error(`WORKFLOW_GRAPH_VERSION_ABSENT:${input.graphId}:${ref.hash}`);
    return { record, created };
  }

  async get(graphId: string, version: string): Promise<WorkflowGraphVersionRecord | null> {
    assertGraphId(graphId);
    if (!VERSION_PATTERN.test(version)) throw Object.assign(new Error("INVALID_WORKFLOW_GRAPH_VERSION"), { statusCode: 400 });
    const text = await readOptional(this.#recordPath(graphId, version));
    if (text === null) return null;
    const stored = parseStored(text, graphId, version);
    const graph = await this.#bodies.get<unknown>(stored.ref);
    // The body must still be the graph this version names.
    if (WorkflowGraphStore.versionOf(graph) !== version) throw new Error(`WORKFLOW_GRAPH_CONTENT_MISMATCH:${graphId}:${version}`);
    return Object.freeze({ ...summaryOf(stored), graph });
  }

  async versions(graphId: string): Promise<readonly WorkflowGraphVersionSummary[]> {
    assertGraphId(graphId);
    const names = await listOptional(join(this.#root, "versions", graphId));
    const records: WorkflowGraphVersionSummary[] = [];
    for (const name of names.filter((item) => /^[a-f0-9]{64}\.json$/u.test(item))) {
      const version = name.slice(0, -5);
      const text = await readOptional(this.#recordPath(graphId, version));
      if (text === null) continue;
      records.push(Object.freeze(summaryOf(parseStored(text, graphId, version))));
    }
    return Object.freeze(records.sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.version.localeCompare(b.version)));
  }

  async list(): Promise<readonly WorkflowGraphSummary[]> {
    const ids = (await listOptional(join(this.#root, "versions"))).filter((name) => WORKFLOW_GRAPH_ID_PATTERN.test(name)).sort();
    const summaries: WorkflowGraphSummary[] = [];
    for (const graphId of ids) {
      const versions = await this.versions(graphId);
      if (versions.length > 0) summaries.push(Object.freeze({ graphId, versions }));
    }
    return Object.freeze(summaries);
  }

  #recordPath(graphId: string, version: string): string { return join(this.#root, "versions", graphId, `${version}.json`); }
}

function summaryOf(stored: StoredVersion): WorkflowGraphVersionSummary {
  return { schemaVersion: stored.schemaVersion, graphId: stored.graphId, version: stored.version, parentVersion: stored.parentVersion, savedAt: stored.savedAt, authorizations: stored.authorizations };
}

function assertGraphId(graphId: string): void {
  if (!WORKFLOW_GRAPH_ID_PATTERN.test(graphId)) throw Object.assign(new Error("INVALID_WORKFLOW_GRAPH_ID"), { statusCode: 400 });
}

function parseStored(text: string, graphId: string, version: string): StoredVersion {
  const value = JSON.parse(text) as Partial<StoredVersion>;
  if (value.schemaVersion !== 1 || value.graphId !== graphId || value.version !== version || value.ref?.hash !== version
    || (value.parentVersion !== null && (typeof value.parentVersion !== "string" || !VERSION_PATTERN.test(value.parentVersion)))
    || typeof value.savedAt !== "string" || !Array.isArray(value.authorizations) || value.authorizations.some((item) => typeof item !== "string")) {
    throw new Error(`INVALID_WORKFLOW_GRAPH_RECORD:${graphId}:${version}`);
  }
  return value as StoredVersion;
}

async function createOnce(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  stagingSequence += 1;
  const staging = `${path}.${process.pid}.${stagingSequence}.tmp`;
  const file = await open(staging, "wx");
  try { await file.writeFile(JSON.stringify(value), "utf8"); await file.sync(); }
  finally { await file.close(); }
  try { await link(staging, path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { await unlink(staging).catch(() => undefined); }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function listOptional(path: string): Promise<readonly string[]> {
  try { return await readdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
