import { createHash } from "node:crypto";

const PROTOCOL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;

export interface ProtocolMetadata {
  readonly author: string;
  readonly date: string;
  readonly rationale: string;
  readonly compatibilityNotes: readonly string[];
  readonly fixture?: true;
}

export interface ProtocolIdentity {
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly protocolHash: string;
}

export type RunProtocolPin = ProtocolIdentity;

export function assertProtocolId(value: string): void {
  if (!PROTOCOL_ID.test(value)) {
    throw new Error(`Invalid protocol id: ${value}`);
  }
}

export function parseSemver(value: string): readonly [number, number, number] {
  const match = SEMVER.exec(value);
  if (match === null) throw new Error(`Invalid protocol semantic version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function nextPatchVersion(version: string): string {
  const [major, minor, patch] = parseSemver(version);
  return `${major}.${minor}.${patch + 1}`;
}

export function hashProtocolBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createRunProtocolPin(identity: ProtocolIdentity): RunProtocolPin {
  assertProtocolId(identity.protocolId);
  parseSemver(identity.protocolVersion);
  if (!SHA_256.test(identity.protocolHash)) {
    throw new Error("A run requires a valid pinned protocol hash.");
  }
  return Object.freeze({
    protocolId: identity.protocolId,
    protocolVersion: identity.protocolVersion,
    protocolHash: identity.protocolHash,
  });
}

export function assertRunProtocolPin(value: unknown): asserts value is RunProtocolPin {
  if (typeof value !== "object" || value === null) {
    throw new Error("A run requires a pinned protocol identity.");
  }
  const candidate = value as Partial<ProtocolIdentity>;
  if (
    typeof candidate.protocolId !== "string"
    || typeof candidate.protocolVersion !== "string"
    || typeof candidate.protocolHash !== "string"
  ) {
    throw new Error("A run requires protocolId, protocolVersion and protocolHash.");
  }
  createRunProtocolPin(candidate as ProtocolIdentity);
}
