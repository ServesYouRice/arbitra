import { createHash } from "node:crypto";
import { cacheBreakpoint, type CacheBreakpoint } from "./cache-breakpoints.js";
import { PROMPT_LAYER_ORDER, type PromptCompileSpec, type PromptLayer, type UntrustedPromptInput } from "./layers.js";
import type { PromptProvenance } from "./provenance.js";

export interface CompiledPrompt {
  readonly bytes: Uint8Array; readonly text: string; readonly hash: string;
  readonly layers: readonly PromptLayer[]; readonly breakpoints: readonly CacheBreakpoint[];
  readonly provenance: PromptProvenance;
}

export function compile(spec: PromptCompileSpec): CompiledPrompt {
  let redactionCount = 0;
  const clean = (text: string): string => {
    if (new TextEncoder().encode(text).byteLength > 1_048_576) throw new Error("Prompt free text exceeds 1 MiB.");
    const result = spec.security.redact(text.normalize("NFC")); redactionCount += result.redactionCount; return result.text;
  };
  const protect = (input: UntrustedPromptInput): string => {
    const redacted = clean(input.content);
    const meta = input.path === undefined ? { sourceId: input.sourceId } : { sourceId: input.sourceId, path: input.path };
    const framed = spec.security.frame(redacted, meta);
    if (!framed.includes('trust="untrusted"')) throw new Error("Security boundary returned unframed repository content.");
    return framed;
  };
  const cleanJson = (value: unknown): unknown => {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) return value.map(cleanJson);
    if (value !== null && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cleanJson(item)]),
    );
    return value;
  };
  const beforeOverride = spec.overrides.before === undefined ? null : clean(spec.overrides.before);
  const afterOverride = spec.overrides.after === undefined ? null : clean(spec.overrides.after);
  const layers: readonly PromptLayer[] = Object.freeze([
    Object.freeze({ layer: "locked", value: { protocol: { id: spec.protocol.protocolId, version: spec.protocol.protocolVersion, hash: spec.protocol.protocolHash, content: clean(spec.protocol.content) }, outputSchema: cleanJson(spec.outputSchema), toolDefinitions: cleanJson(spec.toolDefinitions) } }),
    Object.freeze({ layer: "stable_repository", value: { projectContext: cleanJson(spec.projectContext), artifacts: spec.stableRepositoryArtifacts.map(protect) } }),
    Object.freeze({ layer: "round", value: { artifacts: spec.roundArtifacts.map(protect) } }),
    Object.freeze({ layer: "overrides", value: { before: beforeOverride, after: afterOverride } }),
    Object.freeze({ layer: "instruction", value: { instruction: clean(spec.instruction), grounding: "Quote relevant source lines into a <quotes> block before reasoning.", outputContract: clean(spec.outputContract) } }),
  ]);
  if (layers.map(({ layer }) => layer).some((layer, index) => layer !== PROMPT_LAYER_ORDER[index])) throw new Error("Prompt layer order invariant failed.");
  const encoded = layers.map((layer) => new TextEncoder().encode(canonicalJson(layer)));
  const parts: Uint8Array[] = []; const ends: number[] = []; let length = 0;
  for (const [index, part] of encoded.entries()) { parts.push(part, new TextEncoder().encode(index === encoded.length - 1 ? "" : "\n")); length += part.byteLength + (index === encoded.length - 1 ? 0 : 1); ends.push(length); }
  const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const breakpoints = Object.freeze([cacheBreakpoint("locked", bytes, ends[0]!), cacheBreakpoint("stable_repository", bytes, ends[1]!), cacheBreakpoint("round", bytes, ends[2]!)]);
  const provenance = Object.freeze({ protocolId: spec.protocol.protocolId, protocolVersion: spec.protocol.protocolVersion, protocolHash: spec.protocol.protocolHash, nodeId: spec.nodeId, modelId: spec.modelId, overrides: Object.freeze({ before: beforeOverride, after: afterOverride }), promptHash: hash, redactionCount });
  return Object.freeze({ bytes, text: new TextDecoder().decode(bytes), hash, layers, breakpoints, provenance });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new TypeError("Prompt layer contains a non-JSON value.");
}
