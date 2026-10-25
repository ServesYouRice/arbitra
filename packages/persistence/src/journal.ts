import { mkdir, open, truncate } from "node:fs/promises";
import { dirname } from "node:path";

import type { ArtifactRef } from "./artifact-store.js";
import { canonicalJson } from "./canonical-json.js";
import {
  DEFAULT_FSYNC_POLICY,
  fsync,
  type DurabilityClass,
  type FsyncPolicy,
  type Fsyncable,
} from "./fsync.js";

export interface AttemptStartRecord {
  readonly t: "attempt_start";
  readonly id: string;
  readonly attempt: number;
  readonly providerRequestId?: string;
}

export interface AttemptErrorRecord {
  readonly t: "attempt_error";
  readonly id: string;
  readonly attempt: number;
  readonly error: string;
}

export interface ActivityEndRecord {
  readonly t: "end";
  readonly id: string;
  readonly attempt: number;
  readonly ok: true;
  readonly artifact: ArtifactRef;
  readonly usage: Readonly<Record<string, number>> | null;
}

export type JournalRecord = AttemptStartRecord | AttemptErrorRecord | ActivityEndRecord;

export interface JournalFileHandle extends Fsyncable {
  write(data: Uint8Array): Promise<unknown>;
  stat(): Promise<{ readonly size: number }>;
  close(): Promise<void>;
}

export interface JournalFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: "a"): Promise<JournalFileHandle>;
  truncate(path: string, length: number): Promise<void>;
}

export interface ActivityJournalOptions {
  readonly fileSystem?: JournalFileSystem;
  readonly fsyncPolicy?: FsyncPolicy;
}

const nodeFileSystem: JournalFileSystem = { mkdir, open, truncate };

export class ActivityJournal {
  readonly fsyncPolicy: FsyncPolicy;

  readonly #fileSystem: JournalFileSystem;
  readonly #path: string;

  constructor(path: string, options: ActivityJournalOptions = {}) {
    this.#path = path;
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.fsyncPolicy = options.fsyncPolicy ?? DEFAULT_FSYNC_POLICY;
  }

  async append(record: JournalRecord, durability: DurabilityClass = "cheap"): Promise<void> {
    validateRecord(record);
    await this.#fileSystem.mkdir(dirname(this.#path), { recursive: true });
    const handle = await this.#fileSystem.open(this.#path, "a");
    let start: number | undefined;
    try {
      start = (await handle.stat()).size;
      await handle.write(new TextEncoder().encode(`${canonicalJson(record)}\n`));
      await fsync(handle, this.fsyncPolicy, durability);
    } catch (error) {
      // A failed append is cut back to where it began, so the caller, told it failed, can retry it: a write that fails
      // partway leaves a prefix that the next record would join into one malformed line, and a sync that fails after a
      // full write leaves the whole record, which a retry would record twice. The cut goes by path, since Windows
      // refuses to truncate through a handle opened to append; a failed cut leaves the error as it was.
      if (start !== undefined) await this.#fileSystem.truncate(this.#path, start).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
  }
}

function validateRecord(record: JournalRecord): void {
  if (record.id.length === 0) throw new TypeError("Journal activity id must not be empty");
  if (!Number.isSafeInteger(record.attempt) || record.attempt < 1) {
    throw new TypeError("Journal attempt must be a positive safe integer");
  }
}
