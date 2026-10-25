import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { AuthoredGraph, GraphListing } from "../../api/workflows.js";
import { tokens } from "../../app/token-limit.js";
import { stepName } from "../../app/words.js";
import { record } from "../run/models.js";
import { DEPTHS, isSubscriptionAudit, withDepth, type Depth } from "./depth.js";
import { getIn, graphOf, LIMITS, lines, presetOf, withGraph, withPreset, withScopeKind, type Draft, type Edit } from "./draft.js";

const CONSENSUS: readonly (readonly [string, string])[] = [
  ["full", "every finder reviews every issue"],
  ["risk_weighted", "high-risk issues go to every finder, the rest to two"],
  ["minimal", "only disputed, high-risk, single-finder or low-confidence issues are reviewed"],
];
const TOKEN_LIMIT = ["workflow", "modelExecution", "maximumTokens"] as const;
/** The audit presets' earlier names, which saved lineups may still use. */
const EARLIER_PRESETS: Readonly<Record<string, string>> = Object.freeze({ "audit-balanced": "audit-two-finders", "audit-deep": "audit-three-finders" });
const ASK: readonly (readonly [string, string])[] = [["", "never"], ["interactive", "going on past a question only I can answer, and at a graph's sign-offs"], ["automatic", "never; a graph's sign-offs decide by its rules"]];

/** The closed line of More options: what the options are set to now, so nothing in it is a surprise. */
export function optionsSummary(draft: Draft): string {
  const scope = record(draft["scope"]);
  const kind = scope["kind"] === "module" ? "some folders" : scope["kind"] === "diff" ? "a diff" : "whole project";
  const limit = getIn(draft, TOKEN_LIMIT);
  const ask = getIn(draft, ["workflow", "checkpoints", "mode"]) === "interactive" ? "asks before going on without your answer" : "never stops to ask";
  return [kind, typeof limit === "number" ? `stop at ${tokens(limit)} tokens` : null, ask].filter((part) => part !== null).join(" · ");
}

/**
 * Everything one level down: what to read when it is not the whole project, the leave-outs as paths, the review
 * round's settings, when to ask, where to stop, the steps as a graph, and the lineup as a file.
 */
export function MoreOptions({ draft, edit, setDraft, listing, recommendedLimit, onUseLimit, onImport }: {
  readonly draft: Draft; readonly edit: Edit; readonly setDraft: (next: Draft) => void; readonly listing: GraphListing | null;
  readonly recommendedLimit: number | null; readonly onUseLimit: (value: number) => void; readonly onImport: (file: File) => void;
}): ReactElement {
  const audit = draft["mode"] === "audit";
  const modelBacked = getIn(draft, ["workflow", "modelExecution"]) !== undefined;
  const limit = getIn(draft, TOKEN_LIMIT);
  return <div className="more-options">
    <ScopeFields draft={draft} edit={edit} setDraft={setDraft} />
    {audit && Number(draft["maxConsensusRounds"] ?? 0) > 0 ? <div className="field-row">
      <label className="field">review rounds<input aria-label="review rounds" max={3} min={1} type="number" value={Number(draft["maxConsensusRounds"])} onChange={(event) => edit(["maxConsensusRounds"], Number(event.target.value))} /></label>
      <label className="field">who reviews
        <select aria-label="who reviews" value={String(draft["consensusPolicy"] ?? "risk_weighted")} onChange={(event) => edit(["consensusPolicy"], event.target.value)}>{CONSENSUS.map(([key, words]) => <option key={key} value={key}>{words}</option>)}</select>
      </label>
    </div> : null}
    {audit ? <label className="field">ask me before …
      <select aria-label="ask me before" value={String(getIn(draft, ["workflow", "checkpoints", "mode"]) ?? "")} onChange={(event) => edit(["workflow", "checkpoints"], event.target.value === "" ? undefined : { mode: event.target.value })}>
        {ASK.map(([key, words]) => <option key={key} value={key}>{words}</option>)}
      </select>
      <span className="field__hint">Asked, a run waits for your answer when its plan leaves a question only you can answer; otherwise the question is listed and the run finishes.</span>
    </label> : null}
    {modelBacked ? <div className="field-row limits">{LIMITS.map((entry) => <label className="field" key={entry.label}>{entry.label}
      <input aria-label={entry.label} min={0} type="number" value={Number(getIn(draft, entry.path) ?? 0)} onChange={(event) => edit(entry.path, event.target.value === "" ? undefined : Number(event.target.value))} />
      <span className="field__hint">{entry.hint}{entry.path === LIMITS[0]?.path && recommendedLimit !== null && typeof limit === "number" ? limit === recommendedLimit ? " Set for this project's size."
        : <> {tokens(recommendedLimit)} suits this project&apos;s size. <button className="link-button" type="button" onClick={() => onUseLimit(recommendedLimit)}>use it</button></> : null}</span>
    </label>)}</div> : null}
    {audit && modelBacked ? <label className="tick"><input aria-label="check every place of a rejected merged issue" checked={getIn(draft, ["verification", "reaskMergedPlaces"]) === "always"} type="checkbox" onChange={(event) => edit(["verification", "reaskMergedPlaces"], event.target.checked ? "always" : undefined)} />
      <span>Check every place of a rejected merged issue, also within one file <span className="field__hint">Slower. Within one file it took 10 to 16% of a run&apos;s tokens and confirmed 7 of 50, none of them a planted defect.</span></span></label> : null}
    {audit && !isSubscriptionAudit(draft) && modelBacked ? <label className="field">depth of a step without its own effort
      <select aria-label="depth" value={String(draft["auditDepth"] ?? "balanced")} onChange={(event) => setDraft(withDepth(draft, event.target.value as Depth))}>
        {(Object.keys(DEPTHS) as Depth[]).map((key) => <option key={key} value={key}>{key}</option>)}
      </select>
    </label> : null}
    {audit ? <GraphChoice draft={draft} setDraft={setDraft} listing={listing} /> : null}
    <label className="field">runs the tool loop
      <select aria-label="harness" value={String(getIn(draft, ["harness", "mode"]) ?? "canonical")} onChange={(event) => edit(["harness", "mode"], event.target.value)}><option value="canonical">arbitra, the same for every model</option><option value="native">the vendor&apos;s own agent (writing tests only)</option></select>
      <span className="field__hint">Each model runs in its own CLI either way. arbitra&apos;s own loop lets independent findings be compared.</span>
    </label>
    <JsonView draft={draft} setDraft={setDraft} />
    <label className="field import">import a lineup file (JSON)<input accept="application/json,.json" aria-label="import a lineup file" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) onImport(file); event.target.value = ""; }} /></label>
  </div>;
}

function ScopeFields({ draft, edit, setDraft }: { readonly draft: Draft; readonly edit: Edit; readonly setDraft: (next: Draft) => void }): ReactElement {
  const scope = record(draft["scope"]);
  const kind = String(scope["kind"] ?? "repository");
  return <fieldset className="scope">
    <legend className="panel-title">what to read</legend>
    <label className="field">read
      <select aria-label="scope" value={kind} onChange={(event) => setDraft(withScopeKind(draft, event.target.value))}><option value="repository">the whole project</option><option value="module">some folders</option><option value="diff">a diff</option></select>
    </label>
    {kind !== "module" ? null : <LinesField label="folders, one per line" name="modules" rows={3} values={scope["modules"]} onChange={(values) => edit(["scope", "modules"], values)} />}
    {kind !== "diff" ? null : <>
      <label className="field">diff
        <select aria-label="diff mode" value={String(scope["diffMode"] ?? "range")} onChange={(event) => edit(["scope"], { kind: "diff", diffMode: event.target.value, ...(event.target.value === "range" ? { head: "HEAD" } : {}), ...(Array.isArray(scope["exclude"]) ? { exclude: scope["exclude"] } : {}) })}>
          <option value="range">between two revisions</option><option value="staged">staged changes</option><option value="working_tree">uncommitted changes</option>
        </select>
      </label>
      {(scope["diffMode"] ?? "range") !== "range" ? null : <div className="field-row">
        <label className="field">base revision<input aria-label="base revision" value={String(scope["base"] ?? "")} onChange={(event) => edit(["scope", "base"], event.target.value === "" ? undefined : event.target.value)} /></label>
        <label className="field">head revision<input aria-label="head revision" value={String(scope["head"] ?? "HEAD")} onChange={(event) => edit(["scope", "head"], event.target.value === "" ? undefined : event.target.value)} /></label>
      </div>}
    </>}
    <LinesField label="leave out (paths, one per line; the ticks above write these)" name="left out paths" rows={3} values={scope["exclude"]} onChange={(values) => edit(["scope", "exclude"], values)} />
  </fieldset>;
}

/**
 * A list edited as lines. The text is what the operator typed, blank lines and all; the configuration gets the parsed
 * list. It re-reads the configuration only when the list there changes to something the text does not already say.
 */
function LinesField({ label, name, rows, values, onChange }: { readonly label: string; readonly name: string; readonly rows: number; readonly values: unknown; readonly onChange: (values: readonly string[] | undefined) => void }): ReactElement {
  const listed = Array.isArray(values) ? values.map(String) : [];
  const [text, setText] = useState(listed.join("\n"));
  const parsed = lines(text) ?? [];
  if (parsed.join("\n") !== listed.join("\n") && document.activeElement?.getAttribute("aria-label") !== name) setText(listed.join("\n"));
  return <label className="field">{label}<textarea aria-label={name} rows={rows} value={text} onChange={(event) => { setText(event.target.value); onChange(lines(event.target.value)); }} /></label>;
}

/** The steps as a graph: a preset by finder count or a diff's, or a graph saved in Workflows. */
function GraphChoice({ draft, setDraft, listing }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void; readonly listing: GraphListing | null }): ReactElement {
  const preset = presetOf(draft);
  const saved = graphOf(draft);
  const value = saved === null ? `preset:${preset ?? ""}` : `graph:${saved.id}:${saved.version}`;
  const templates = listing?.templates ?? [];
  const presets = templates.length === 0 ? ["audit-two-finders", "audit-three-finders", "diff-review", "diff-fast"] : templates.map(({ id }) => id);
  if (preset !== null && saved === null && !presets.includes(preset)) presets.push(preset);
  const pipeline = saved === null ? templates.find(({ id }) => id === (EARLIER_PRESETS[preset ?? ""] ?? preset)) : undefined;
  return <label className="field">steps as a graph
    <select aria-label="graph" value={value} onChange={(event) => { const [kind, id, version] = event.target.value.split(":"); if (kind === "preset" && id !== undefined) setDraft(withPreset(draft, id)); if (kind === "graph" && id !== undefined && version !== undefined) setDraft(withGraph(draft, { id, version })); }}>
      <optgroup label="presets">{presets.map((id) => <option key={id} value={`preset:${id}`}>{id}{EARLIER_PRESETS[id] === undefined ? "" : ` (the earlier name of ${EARLIER_PRESETS[id]})`}</option>)}</optgroup>
      {(listing?.graphs ?? []).length === 0 ? null : <optgroup label="saved graphs">{(listing?.graphs ?? []).flatMap(({ graphId, versions }) => versions.map(({ version }) => <option key={`${graphId}:${version}`} value={`graph:${graphId}:${version}`}>{graphId} @ {version.slice(0, 12)}</option>))}</optgroup>}
    </select>
    <span className="field__hint">{saved !== null ? `The graph ${saved.id} @ ${saved.version.slice(0, 12)}, saved in Workflows.` : "Set by the finders above; a diff's presets read a diff."}{pipeline === undefined ? "" : ` Steps: ${describePipeline(pipeline)}.`}</span>
  </label>;
}

/** A preset's steps in order, by the design language's names; steps side by side once, counted ("Find issues ×2"). */
export function describePipeline(graph: AuthoredGraph): string {
  const incoming = new Map(graph.nodes.map(({ id }) => [id, graph.edges.filter(({ to }) => to === id).length]));
  const layers: string[][] = [];
  let frontier = graph.nodes.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id);
  const seen = new Set<string>();
  while (frontier.length > 0 && layers.length < graph.nodes.length) {
    const names = frontier.map((id) => { const node = graph.nodes.find((entry) => entry.id === id); return node === undefined ? id : stepName(node, "audit"); });
    layers.push([...new Set(names)].map((name) => { const count = names.filter((entry) => entry === name).length; return count === 1 ? name : `${name} ×${count}`; }));
    for (const id of frontier) seen.add(id);
    frontier = [...new Set(graph.edges.filter(({ from }) => frontier.includes(from)).map(({ to }) => to))].filter((id) => !seen.has(id) && graph.edges.filter(({ to }) => to === id).every(({ from }) => seen.has(from)));
  }
  return layers.map((layer) => layer.join(", ")).join(" → ");
}

/** The lineup as the JSON that is saved; edits apply only over the lineup they started from. */
function JsonView({ draft, setDraft }: { readonly draft: Draft; readonly setDraft: (next: Draft) => void }): ReactElement {
  const formatted = useMemo(() => JSON.stringify(draft, null, 2), [draft]);
  const [text, setText] = useState(formatted);
  const [error, setError] = useState<string | null>(null);
  // The lineup the JSON edits started from; null while the JSON simply follows the page.
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => { if (base === null) setText(formatted); }, [formatted, base]);
  const stale = base !== null && base !== formatted;
  const apply = (): void => {
    // Applying edits made over an older lineup would silently undo the page's changes.
    if (stale) { setError("the page changed after these JSON edits began; discard them and edit again"); return; }
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the lineup must be a JSON object");
      setBase(null); setError(null); setDraft(value as Draft);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <details className="disclosure json-view">
    <summary>the lineup as JSON · {base === null ? "exactly what is saved" : "edited, not yet applied"}</summary>
    <textarea aria-label="lineup JSON" rows={18} spellCheck={false} value={text} onChange={(event) => { if (base === null) setBase(formatted); setText(event.target.value); }} />
    {stale ? <p className="state" data-state="degraded" role="status">the page changed after these JSON edits began · applying them is refused</p> : null}
    <div className="actions">
      <button className="button" disabled={base === null} type="button" onClick={apply}>apply JSON</button>
      <button className="button" disabled={base === null} type="button" onClick={() => { setBase(null); setError(null); setText(formatted); }}>discard JSON edits</button>
    </div>
    <p className="field__hint"><code>budgets</code>, <code>security</code> and <code>contextPolicies</code> are not enforced; the check warns when they are set. The stop above limits spend.</p>
    {error === null ? null : <p className="state" data-state="refuted" role="alert">not applied · {error}</p>}
  </details>;
}
