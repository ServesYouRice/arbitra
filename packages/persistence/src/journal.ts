import { mkdir, open } from "node:fs/promises";
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
  close(): Promise<void>;
}

export interface JournalFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: "a"): Promise<JournalFileHandle>;
}

export interface ActivityJournalOptions {
  readonly fileSystem?: JournalFileSystem;
  readonly fsyncPolicy?: FsyncPolicy;
}

const nodeFileSystem: JournalFileSystem = { mkdir, open };

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
    try {
      await handle.write(new TextEncoder().encode(`${canonicalJson(record)}\n`));
      await fsync(handle, this.fsyncPolicy, durability);
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
