import { useEffect, useState, type ReactElement } from "react";
import { ArtifactApi, type ArtifactResource } from "../api/artifacts.js";
import { artifactName } from "../app/format.js";

/**
 * One persisted artifact, read-only. Content is redacted at write time and rendered only as
 * text. A compiled prompt is shown as what the model received: its provenance, then each
 * prompt layer at the byte boundaries the compiler recorded.
 */
export function ArtifactView({ api, runId, artifactId }: { readonly api: ArtifactApi; readonly runId: string; readonly artifactId: string }): ReactElement {
  const [artifact, setArtifact] = useState<ArtifactResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setArtifact(null); setError(null);
    let active = true;
    void api.load(runId, artifactId).then((value) => { if (active) { setArtifact(value); setError(null); } }, (cause: unknown) => { if (active) { setArtifact(null); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { active = false; };
  }, [api, runId, artifactId]);
  if (error !== null) return <p className="state" data-state="degraded" role="alert">artifact unavailable · {error}</p>;
  if (artifact === null) return <p role="status">loading artifact</p>;
  const { name, hash } = artifactName(artifact.kind);
  const prompt = artifact.kind.startsWith("compiled-prompt") ? compiledPrompt(artifact.content) : null;
  return <article aria-label={`artifact ${artifact.artifactId}`} className="artifact" data-artifact-id={artifact.artifactId}>
    <h3 className="artifact__title">{name}{hash === null ? "" : ` · ${hash}`}</h3>
    <p className="state" data-state="tainted">persisted redacted content · {artifact.bytes} bytes{artifact.nodeId == null ? "" : ` · node ${artifact.nodeId}`}</p>
    {prompt === null ? <pre className="artifact__content">{pretty(artifact.content)}</pre> : <PromptLayers prompt={prompt} />}
    {artifact.truncated ? <p className="state" data-state="unexamined">truncated · continuation artifact {artifact.continuationArtifactId ?? "unavailable"}</p> : <p className="note">complete bounded artifact · {artifact.artifactId}</p>}
  </article>;
}

interface CompiledPrompt {
  readonly provenance: { readonly modelId?: string; readonly nodeId?: string; readonly protocolId?: string; readonly protocolVersion?: string; readonly protocolHash?: string; readonly promptHash?: string; readonly redactionCount?: number; readonly overrides?: { readonly before?: string | null; readonly after?: string | null } };
  readonly layers: readonly { readonly name: string; readonly text: string }[];
}

function PromptLayers({ prompt }: { readonly prompt: CompiledPrompt }): ReactElement {
  const { provenance } = prompt;
  return <>
    <dl className="facts">
      <div><dt>protocol</dt><dd>{provenance.protocolId ?? "unavailable"}@{provenance.protocolVersion ?? "unavailable"}</dd></div>
      <div><dt>model</dt><dd>{provenance.modelId ?? "unavailable"}</dd></div>
      <div><dt>node</dt><dd>{provenance.nodeId ?? "unavailable"}</dd></div>
      <div><dt>prompt hash</dt><dd>{provenance.promptHash ?? "unavailable"}</dd></div>
      <div><dt>protocol hash</dt><dd>{provenance.protocolHash ?? "unavailable"}</dd></div>
      <div><dt>operator overrides</dt><dd>{provenance.overrides?.before ?? provenance.overrides?.after ?? "none"}</dd></div>
      <div><dt>redactions</dt><dd>{provenance.redactionCount ?? "unavailable"}</dd></div>
    </dl>
    {prompt.layers.map((layer, index) => <details className="disclosure" key={`${layer.name}-${index}`}>
      <summary>prompt layer · {layer.name}</summary>
      <pre className="artifact__content">{pretty(layer.text)}</pre>
    </details>)}
  </>;
}

/** The compiler's breakpoints are UTF-8 byte offsets; anything unexpected falls back to plain content. */
function compiledPrompt(content: string): CompiledPrompt | null {
  try {
    const value = JSON.parse(content) as { provenance?: CompiledPrompt["provenance"]; text?: unknown; breakpoints?: readonly { afterLayer?: unknown; endByte?: unknown }[] };
    if (typeof value.text !== "string" || typeof value.provenance !== "object" || value.provenance === null) return null;
    const bytes = new TextEncoder().encode(value.text);
    const decoder = new TextDecoder();
    const layers: { name: string; text: string }[] = [];
    let start = 0;
    for (const { afterLayer, endByte } of value.breakpoints ?? []) {
      if (typeof afterLayer !== "string" || typeof endByte !== "number" || endByte < start || endByte > bytes.length) return null;
      layers.push({ name: afterLayer.replaceAll("_", " "), text: decoder.decode(bytes.slice(start, endByte)) });
      start = endByte;
    }
    if (start < bytes.length) layers.push({ name: "remainder", text: decoder.decode(bytes.slice(start)) });
    return { provenance: value.provenance, layers };
  } catch { return null; }
}

/** JSON reads better indented; anything else is shown exactly as stored. */
function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
