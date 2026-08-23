import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
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
}

export interface ArtifactStoreOptions {
  readonly fileSystem?: ArtifactFileSystem;
  readonly fsyncPolicy?: FsyncPolicy;
}

export interface PutArtifactOptions {
  readonly durability?: DurabilityClass;
}

const nodeFileSystem: ArtifactFileSystem = { mkdir, open, readFile };

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
    validateExtension(extension);
    const bytes = new TextEncoder().encode(canonicalJson(value));
    const hash = sha256(bytes);
    const fileName = `${hash}.${extension}`;
    const path = join(this.#artifactDirectory, fileName);
    const ref = Object.freeze({
      hash,
      byteLength: bytes.byteLength,
      extension,
      relativePath: `artifacts/${fileName}`,
    });

    await this.#fileSystem.mkdir(this.#artifactDirectory, { recursive: true });

    let handle: ArtifactFileHandle;
    try {
      handle = await this.#fileSystem.open(path, "wx");
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await this.#assertExistingArtifact(path, bytes);
      return ref;
    }

    try {
      await handle.writeFile(bytes);
      await fsync(handle, this.fsyncPolicy, options.durability ?? "expensive");
    } finally {
      await handle.close();
    }

    return ref;
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

  async #assertExistingArtifact(path: string, expected: Uint8Array): Promise<void> {
    const existing = await this.#fileSystem.readFile(path);
    if (existing.byteLength !== expected.byteLength || sha256(existing) !== sha256(expected)) {
      throw new Error("Existing content-addressed artifact does not contain the expected bytes");
    }
  }
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
