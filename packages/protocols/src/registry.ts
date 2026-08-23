import {
  assertProtocolId,
  compareSemver,
  hashProtocolBytes,
  nextPatchVersion,
  parseSemver,
  type ProtocolIdentity,
  type ProtocolMetadata,
} from "./versioning.js";

export type ProtocolControlPlaneSource = "trusted_base" | "external_config" | "test_fixture";

export interface ProtocolAsset {
  readonly protocolBytes: Uint8Array;
  readonly metadataBytes: Uint8Array;
  readonly source: ProtocolControlPlaneSource;
  readonly sourceRevision: string | null;
}

export interface ProtocolControlPlane {
  read(id: string, version: string): Promise<ProtocolAsset | null>;
  listVersions(id: string): Promise<readonly string[]>;
}

export interface PinnedProtocol extends ProtocolIdentity {
  readonly content: string;
  readonly metadata: ProtocolMetadata;
  readonly source: Exclude<ProtocolControlPlaneSource, "test_fixture"> | "test_fixture";
  readonly sourceRevision: string | null;
}

export interface ProtocolDraft {
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly content: string;
  readonly protocolHash: string;
  readonly metadata: ProtocolMetadata;
  readonly forkedFrom: ProtocolIdentity;
}

export interface TextDiffLine {
  readonly kind: "context" | "added" | "removed";
  readonly text: string;
}

export interface TextDiff {
  readonly from: ProtocolIdentity;
  readonly to: ProtocolIdentity;
  readonly changed: boolean;
  readonly lines: readonly TextDiffLine[];
}

interface RegistryOptions {
  readonly allowTestFixtures?: boolean;
}

export class ProtocolRegistry {
  readonly #controlPlane: ProtocolControlPlane | undefined;
  readonly #allowTestFixtures: boolean;

  constructor(controlPlane?: ProtocolControlPlane, options: RegistryOptions = {}) {
    this.#controlPlane = controlPlane;
    this.#allowTestFixtures = options.allowTestFixtures === true;
  }

  async resolve(
    id: string,
    version: string,
    controlPlane: ProtocolControlPlane | undefined = this.#controlPlane,
  ): Promise<PinnedProtocol> {
    assertProtocolId(id);
    parseSemver(version);
    if (controlPlane === undefined) throw new Error("A trusted protocol control plane is required.");

    const asset = await controlPlane.read(id, version);
    if (asset === null) throw new Error(`Protocol ${id}@${version} was not found.`);
    const metadata = parseMetadata(asset.metadataBytes);
    const fixture = asset.source === "test_fixture" || metadata.fixture === true;
    if (fixture && !this.#allowTestFixtures) {
      throw new Error("Test fixture protocols cannot be resolved by the production registry.");
    }
    if (this.#allowTestFixtures && asset.source === "test_fixture" && metadata.fixture !== true) {
      throw new Error("A test fixture protocol must be explicitly tagged in metadata.");
    }
    if (!fixture && asset.source !== "trusted_base" && asset.source !== "external_config") {
      throw new Error("Protocol source is not a trusted control-plane source.");
    }

    const content = new TextDecoder("utf-8", { fatal: true }).decode(asset.protocolBytes);
    return Object.freeze({
      protocolId: id,
      protocolVersion: version,
      protocolHash: hashProtocolBytes(asset.protocolBytes),
      content,
      metadata,
      source: asset.source,
      sourceRevision: asset.sourceRevision,
    });
  }

  select(id: string, version: string): Promise<PinnedProtocol> {
    return this.resolve(id, version);
  }

  async fork(id: string, version: string): Promise<ProtocolDraft> {
    const source = await this.resolve(id, version);
    const versions = await this.requireControlPlane().listVersions(id);
    let targetVersion = nextPatchVersion(version);
    while (versions.includes(targetVersion)) targetVersion = nextPatchVersion(targetVersion);
    return draftFrom(source, id, targetVersion);
  }

  async duplicate(id: string, version: string, targetId: string): Promise<ProtocolDraft> {
    assertProtocolId(targetId);
    const source = await this.resolve(id, version);
    const versions = await this.requireControlPlane().listVersions(targetId);
    const targetVersion = versions.length === 0
      ? "1.0.0"
      : nextPatchVersion([...versions].sort(compareSemver).at(-1)!);
    return draftFrom(source, targetId, targetVersion);
  }

  edit(draft: ProtocolDraft, content: string, metadata: ProtocolMetadata = draft.metadata): ProtocolDraft {
    if (content === draft.content && metadata === draft.metadata) return draft;
    return Object.freeze({
      ...draft,
      content,
      protocolHash: hashProtocolBytes(new TextEncoder().encode(content)),
      metadata: freezeMetadata(metadata),
    });
  }

  diff(a: PinnedProtocol | ProtocolDraft, b: PinnedProtocol | ProtocolDraft): TextDiff {
    return Object.freeze({
      from: identityOf(a),
      to: identityOf(b),
      changed: a.protocolHash !== b.protocolHash,
      lines: Object.freeze(diffLines(a.content, b.content)),
    });
  }

  private requireControlPlane(): ProtocolControlPlane {
    if (this.#controlPlane === undefined) {
      throw new Error("This operation requires a registry bound to a trusted control plane.");
    }
    return this.#controlPlane;
  }
}

/** Deliberately named test entrypoint; production resolution rejects fixture-tagged assets. */
export function createTestProtocolRegistry(controlPlane: ProtocolControlPlane): ProtocolRegistry {
  return new ProtocolRegistry(controlPlane, { allowTestFixtures: true });
}

function draftFrom(source: PinnedProtocol, targetId: string, targetVersion: string): ProtocolDraft {
  if (targetId === source.protocolId && compareSemver(targetVersion, source.protocolVersion) <= 0) {
    throw new Error("A fork must use a new, later semantic version.");
  }
  return Object.freeze({
    protocolId: targetId,
    protocolVersion: targetVersion,
    content: source.content,
    protocolHash: source.protocolHash,
    metadata: source.metadata,
    forkedFrom: identityOf(source),
  });
}

function identityOf(value: ProtocolIdentity): ProtocolIdentity {
  return Object.freeze({
    protocolId: value.protocolId,
    protocolVersion: value.protocolVersion,
    protocolHash: value.protocolHash,
  });
}

function parseMetadata(bytes: Uint8Array): ProtocolMetadata {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Protocol metadata must be valid UTF-8 JSON.");
  }
  if (typeof value !== "object" || value === null) throw new Error("Invalid protocol metadata.");
  const metadata = value as Partial<ProtocolMetadata>;
  if (
    typeof metadata.author !== "string" || metadata.author.trim() === ""
    || typeof metadata.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(metadata.date)
    || typeof metadata.rationale !== "string" || metadata.rationale.trim() === ""
    || !Array.isArray(metadata.compatibilityNotes)
    || !metadata.compatibilityNotes.every((note) => typeof note === "string")
    || (metadata.fixture !== undefined && metadata.fixture !== true)
  ) {
    throw new Error("Protocol metadata requires author, ISO date, rationale and compatibilityNotes.");
  }
  return freezeMetadata(metadata as ProtocolMetadata);
}

function freezeMetadata(metadata: ProtocolMetadata): ProtocolMetadata {
  return Object.freeze({
    author: metadata.author,
    date: metadata.date,
    rationale: metadata.rationale,
    compatibilityNotes: Object.freeze([...metadata.compatibilityNotes]),
    ...(metadata.fixture === true ? { fixture: true as const } : {}),
  });
}

function diffLines(before: string, after: string): TextDiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = left[i] === right[j]
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const output: TextDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      output.push(Object.freeze({ kind: "context", text: left[i]! }));
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      output.push(Object.freeze({ kind: "added", text: right[j]! }));
      j += 1;
    } else {
      output.push(Object.freeze({ kind: "removed", text: left[i]! }));
      i += 1;
    }
  }
  return output;
}
