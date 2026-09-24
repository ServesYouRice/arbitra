import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import {
  DEFAULT_FSYNC_POLICY,
  fsync,
  type DurabilityClass,
  type FsyncPolicy,
  type Fsyncable,
} from "./fsync.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const extensionPattern = /^[a-z0-9][a-z0-9_-]*$/u;

export interface ArtifactRef<Extension extends string = string> {
  readonly hash: string;
  readonly byteLength: number;
  readonly extension: Extension;
  readonly relativePath: string;
}

export interface ArtifactFileHandle extends Fsyncable {
  writeFile(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ArtifactFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: "wx"): Promise<ArtifactFileHandle>;
  readFile(path: string): Promise<Uint8Array>;
  /** Publish a complete file under a new name; fails with EEXIST if the name is taken. */
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ArtifactStoreOptions {
  readonly fileSystem?: ArtifactFileSystem;
  readonly fsyncPolicy?: FsyncPolicy;
}

export interface PutArtifactOptions {
  readonly durability?: DurabilityClass;
}

const nodeFileSystem: ArtifactFileSystem = { mkdir, open, readFile, link, rename, unlink };

// Distinguishes concurrent writers' staging files; the pid separates processes and the
// counter separates puts within one. Staging names never reach an artifact reference.
let stagingSequence = 0;

export class ArtifactStore {
  readonly fsyncPolicy: FsyncPolicy;

  readonly #artifactDirectory: string;
  readonly #fileSystem: ArtifactFileSystem;

  constructor(rootDirectory: string, options: ArtifactStoreOptions = {}) {
    this.#artifactDirectory = join(rootDirectory, "artifacts");
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.fsyncPolicy = options.fsyncPolicy ?? DEFAULT_FSYNC_POLICY;
  }

  async put<Extension extends string>(
    value: unknown,
    extension: Extension,
    options: PutArtifactOptions = {},
  ): Promise<ArtifactRef<Extension>> {
    const { ref, bytes } = encodeArtifact(value, extension);
    const path = join(this.#artifactDirectory, `${ref.hash}.${extension}`);

    await this.#fileSystem.mkdir(this.#artifactDirectory, { recursive: true });

    const existing = await this.#readExisting(path);
    if (existing !== undefined && matches(existing, bytes)) return ref;

    // Stage the complete, flushed bytes and only then publish them under the content address.
    // Creating the final name first let a concurrent put (or a later run after a crash
    // mid-write) find an empty or partial file there and fail the content check.
    stagingSequence += 1;
    const staging = `${path}.${process.pid}-${stagingSequence}.tmp`;
    const handle = await this.#fileSystem.open(staging, "wx");
    try {
      try {
        await handle.writeFile(bytes);
        await fsync(handle, this.fsyncPolicy, options.durability ?? "expensive");
      } finally {
        await handle.close();
      }
      if (existing === undefined) {
        try {
          await this.#fileSystem.link(staging, path);
          return ref;
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error;
        }
        // Another writer published first. Its file is complete by construction.
        const published = await this.#readExisting(path);
        if (published !== undefined && matches(published, bytes)) return ref;
      }
      // A file that fails its own content address (torn by a crash before staging existed)
      // can only be replaced by the bytes it names, so the atomic swap is safe.
      await this.#fileSystem.rename(staging, path);
      return ref;
    } finally {
      await this.#fileSystem.unlink(staging).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      });
    }
  }

  async get<T>(ref: ArtifactRef): Promise<T> {
    validateRef(ref);
    const expectedRelativePath = `artifacts/${ref.hash}.${ref.extension}`;
    if (ref.relativePath !== expectedRelativePath) {
      throw new Error("Artifact reference path does not match its hash and extension");
    }

    const bytes = await this.#fileSystem.readFile(
      join(this.#artifactDirectory, `${ref.hash}.${ref.extension}`),
    );
    if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.hash) {
      throw new Error(`Artifact ${ref.relativePath} failed its content-address check`);
    }

    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  }

  /** Resolve a persisted trace reference without trusting it as a filesystem path. */
  async getByRelativePath<T>(relativePath: string): Promise<T> {
    const match = /^artifacts\/([a-f0-9]{64})\.([a-z0-9][a-z0-9_-]*)$/u.exec(relativePath);
    if (match === null) throw new TypeError("INVALID_ARTIFACT_REFERENCE");
    const bytes = await this.#fileSystem.readFile(join(this.#artifactDirectory, `${match[1]}.${match[2]}`));
    if (sha256(bytes) !== match[1]) throw new Error("ARTIFACT_CONTENT_ADDRESS_MISMATCH");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  }

  async #readExisting(path: string): Promise<Uint8Array | undefined> {
    try {
      return await this.#fileSystem.readFile(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }
}

function matches(existing: Uint8Array, expected: Uint8Array): boolean {
  return existing.byteLength === expected.byteLength && sha256(existing) === sha256(expected);
}

/** The reference `put` would return for a value, computed without touching the filesystem. */
export function contentAddress<Extension extends string>(value: unknown, extension: Extension): ArtifactRef<Extension> {
  return encodeArtifact(value, extension).ref;
}

function encodeArtifact<Extension extends string>(value: unknown, extension: Extension): { readonly ref: ArtifactRef<Extension>; readonly bytes: Uint8Array } {
  validateExtension(extension);
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = sha256(bytes);
  const ref = Object.freeze({ hash, byteLength: bytes.byteLength, extension, relativePath: `artifacts/${hash}.${extension}` });
  return { ref, bytes };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateExtension(extension: string): void {
  if (!extensionPattern.test(extension)) {
    throw new TypeError(`Invalid artifact extension: ${extension}`);
  }
}

function validateRef(ref: ArtifactRef): void {
  if (!hashPattern.test(ref.hash)) throw new TypeError("Invalid artifact hash");
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new TypeError("Invalid artifact byte length");
  }
  validateExtension(ref.extension);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
