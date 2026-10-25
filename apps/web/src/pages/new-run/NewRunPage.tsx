import "./new-run.css";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useConfigurations } from "../../api/configurations.js";
import type { PreflightResult } from "../../api/runs.js";
import { useLoaded } from "../../api/runs.js";
import type { AuthoredGraph, GraphListing } from "../../api/workflows.js";
import { useApis } from "../../app/apis.js";
import { MODE_LABELS } from "../../app/format.js";
import { recommendedTokenLimit, tokens } from "../../app/token-limit.js";
import { useNavigation } from "../../app/router.js";
import { stableJson } from "../../graph/editor-model.js";
import { effortFor, modelName, modelProfiles, PLACEHOLDER_PREFIX, record, roleEffort, type ModelProfileSummary } from "../run/models.js";
import { modelSettings, offeredCatalog, withStrongestOffered, type CatalogModel, type OfferedModels } from "./model-catalog.js";
import { getIn, graphOf, LIMITS, lines, modeOf, placeholders, presetOf, roleSlots, setIn, suggestedName, withGraph, withPreset, withScopeKind, type Draft, type RoleSlot } from "./draft.js";
import { DEFAULT_START, SCRIPTED_AUDIT, TEMPLATES } from "./templates.js";

const PRESET_SHAPES: Readonly<Record<string, string>> = Object.freeze({
  "audit-two-finders": "Two independent finders, bounded peer review, verification and a planner.",
  "audit-three-finders": "Three independent finders, bounded peer review, verification and a planner.",
  "diff-review": "Two independent auditors over a diff, bounded review, verification and a planner.",
  "diff-fast": "One auditor over a diff, deterministic verification and a planner; no peer review, so every issue stays single-source.",
});
/** The audit presets' earlier names, which saved configurations may still use. */
const EARLIER_PRESETS: Readonly<Record<string, string>> = Object.freeze({ "audit-balanced": "audit-two-finders", "audit-deep": "audit-three-finders" });
const shapeOf = (preset: string): string | undefined => {
  const current = EARLIER_PRESETS[preset];
  return current === undefined ? PRESET_SHAPES[preset] : `The earlier name of ${current}. ${PRESET_SHAPES[current] ?? ""}`;
};
const CONSENSUS: readonly (readonly [string, string])[] = [
  ["full", "every auditor reviews every issue"],
  ["risk_weighted", "high-risk issues go to every auditor, the rest to two reviewers"],
  ["minimal", "only disputed, high-risk, single-source or low-confidence issues are reviewed"],
];
const DEPTH: readonly (readonly [string, string])[] = [["fast", "low effort"], ["balanced", "medium effort"], ["deep", "high effort"]];
const LEAVE = { title: "unsaved configuration", description: "This configuration has changes that are not saved. Leaving or choosing another starting point discards them." } as const;

interface Loaded { readonly draft: Draft; readonly name: string; readonly savedId: string | null; readonly source: string; readonly repository?: string }

/**
 * Prepare and start a run. Everything here edits one configuration object, which is what
 * gets saved; the orchestrator's own preflight and estimate check it before anything runs.
 * A run always starts from a saved configuration, so starting saves it first, and the
 * button says which save that is.
 */
export function NewRunPage({ from, graph }: { readonly from: string | null; readonly graph: string | null }): ReactElement {
  const apis = useApis();
  const { navigate, setGuard } = useNavigation();
  const { configurations, reload } = useConfigurations(apis.configurations);
  const defaultRepository = useLoaded("repository", () => apis.runs.selectedRepository());
  const listing = useLoaded<GraphListing>("workflows", () => apis.workflows.list());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(SCRIPTED_AUDIT);
  const [name, setName] = useState("");
  const [repository, setRepository] = useState<string | null>(null);
  const [check, setCheck] = useState<{ readonly result: PreflightResult; readonly draft: Draft } | null>(null);
  const [busy, setBusy] = useState<"checking" | "saving" | "starting" | null>(null);
  const [failure, setFailure] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<DetectedEnvironment | null>(null);
  const [environmentFailure, setEnvironmentFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickFailure, setPickFailure] = useState<string | null>(null);

  // The starting point is part of the address, so a template or a rerun is a link.
  useEffect(() => {
    let active = true;
    setLoadError(null); setCheck(null); setFailure([]); setNotice(null);
    void startingPoint(from, graph, apis).then((value) => { if (!active) return; setLoaded(value); setDraft(value.draft); setName(value.name); if (value.repository !== undefined) setRepository(value.repository); }, (cause: unknown) => { if (active) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [from, graph, apis]);

  const dirty = loaded !== null && (stableJson(draft) !== stableJson(loaded.draft) || name !== loaded.name);
  const loadEnvironment = (refresh: boolean): void => {
    setEnvironmentFailure(null);
    void fetch(`/diagnostics/environment${refresh ? "?refresh=1" : ""}`).then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); setEnvironment(await response.json() as DetectedEnvironment); })
      .catch((error: unknown) => setEnvironmentFailure(error instanceof Error ? error.message : String(error)));
  };
  useEffect(() => { loadEnvironment(false); }, []);
  const offered = useMemo(() => offeredModels(environment), [environment]);
  // A template not yet edited takes the strongest Gemini this machine's CLI offers (Argon), as it does for the others.
  useEffect(() => {
    if (loaded === null || dirty || !(from === null || from.startsWith("template:"))) return;
    const upgraded = withStrongestOffered(loaded.draft, offered);
    if (upgraded !== loaded.draft) { setLoaded({ ...loaded, draft: upgraded }); setDraft(upgraded); }
  }, [offered, loaded, dirty, from]);
  useEffect(() => { setGuard(dirty ? LEAVE : null); }, [dirty, setGuard]);
  useEffect(() => () => setGuard(null), [setGuard]);

  const mode = modeOf(draft);
  const edit = (path: readonly string[], value: unknown): void => setDraft((current) => setIn(current, path, value));
  const repositoryPath = repository ?? defaultRepository.value?.repository ?? "";
  const stale = check !== null && stableJson(check.draft) !== stableJson(draft);
  const open = placeholders(draft);
  const updating = loaded?.savedId != null && name === loaded.name;

  // The check measures the project, so it sets the token limit for its size unless the limit was set by hand: one
  // still at the starting point's value, or at the value an earlier check set.
  const autoLimit = useRef<number | null>(null);
  const sizedLimit = (result: PreflightResult, current: Draft): Draft => {
    const limit = getIn(current, TOKEN_LIMIT);
    const estimate = result.estimate?.estimate;
    if (estimate === undefined || typeof limit !== "number" || (limit !== getIn(loaded?.draft ?? {}, TOKEN_LIMIT) && limit !== autoLimit.current)) return current;
    const recommended = recommendedTokenLimit(estimate.lines, estimate.auditors);
    autoLimit.current = recommended;
    return recommended === limit ? current : setIn(current, TOKEN_LIMIT, recommended);
  };
  const runCheck = async (): Promise<{ readonly result: PreflightResult; readonly draft: Draft } | null> => {
    setBusy("checking"); setFailure([]);
    try {
      const result = await apis.runs.preflight(draft, repositoryPath);
      const checked = sizedLimit(result, draft);
      // Sizing the limit is the check's own setting, like the starting point's: it leaves an unedited page unedited.
      if (checked !== draft && loaded !== null && stableJson(draft) === stableJson(loaded.draft)) setLoaded({ ...loaded, draft: checked });
      setDraft(checked); setCheck({ result, draft: checked });
      return { result, draft: checked };
    }
    catch (cause) { setFailure([message(cause)]); return null; }
    finally { setBusy(null); }
  };
  const save = async (target: Draft = draft): Promise<string | null> => {
    setBusy("saving"); setFailure([]); setNotice(null);
    try {
      const saved = updating && loaded?.savedId != null ? await apis.configurations.update(loaded.savedId, name, target) : await apis.configurations.save(name, target);
      setLoaded({ draft: target, name: saved.name, savedId: saved.id, source: `saved configuration ${saved.name}` });
      setNotice(`saved as configuration ${saved.name}`);
      void reload();
      return saved.id;
    } catch (cause) { setFailure([message(cause)]); return null; }
    finally { setBusy(null); }
  };
  const start = async (): Promise<void> => {
    const checked = await runCheck();
    if (checked === null || !checked.result.ready) return;
    const id = await save(checked.draft);
    if (id === null) return;
    setBusy("starting");
    try {
      const run = await apis.runs.start(id, repositoryPath);
      rememberRepository(repositoryPath);
      setGuard(null);
      navigate({ page: "run", runId: run.runId, tab: null, item: null });
    } catch (cause) { setFailure(message(cause).split("\n")); }
    finally { setBusy(null); }
  };
  const browse = async (): Promise<void> => {
    setPicking(true); setPickFailure(null);
    try { const { path } = await apis.runs.pickRepository(); if (path !== null) setRepository(path); }
    catch (cause) { setPickFailure(`the folder dialog could not open · ${message(cause)} · paste the path instead`); }
    finally { setPicking(false); }
  };
  const importFile = async (file: File): Promise<void> => {
    try {
      const value: unknown = JSON.parse(await file.text());
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the file is not a JSON object");
      setDraft(value as Draft); setName(file.name.replace(/\.json$/iu, "")); setCheck(null); setFailure([]); setNotice(`imported ${file.name} · check it before starting`);
    } catch (cause) { setFailure([`import failed · ${message(cause)}`]); }
  };

  const startKey = from ?? (graph === null ? DEFAULT_START : "graph");
  return <div className="new-run">
    <div className="page-head"><div className="page-head__text">
      <h1 className="page-title">New run</h1>
      <p className="lead">Choose where to start, fill in what that leaves open, check it, then start. Nothing runs until you press start.</p>
    </div></div>
    {loadError === null ? null : <p className="state" data-state="degraded" role="alert">the starting point could not be loaded · {loadError}</p>}

    <Section title="start from" id="start">
      <label className="field">starting point
        <select aria-label="starting point" value={startKey} onChange={(event) => navigate({ page: "new-run", from: event.target.value, graph: null }, { replace: true })}>
          {startKey === "graph" ? <option value="graph">saved workflow graph {graph}</option> : null}
          {startKey.startsWith("run:") ? <option value={startKey}>settings of run {startKey.slice(4)}</option> : null}
          <optgroup label="templates">{TEMPLATES.map((template) => <option key={template.id} value={`template:${template.id}`}>{template.label}</option>)}</optgroup>
          {configurations.length === 0 ? null : <optgroup label="saved configurations">{configurations.map(({ id, name: label }) => <option key={id} value={`config:${id}`}>{label}</option>)}</optgroup>}
        </select>
      </label>
      <p className="prose">{describeStart(startKey, loaded)}</p>
      <label className="field import">import a configuration file (JSON)<input accept="application/json,.json" aria-label="import a configuration file" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void importFile(file); event.target.value = ""; }} /></label>
      <p className="field__hint">Optional. A configuration file is every setting on this page saved as JSON, such as one someone sent you or one exported from a saved configuration. Importing it fills in this page; nothing runs until you start it.</p>
    </Section>

    <Section title="repository" id="repository">
      <div className="repository-row">
        <label className="field">repository path<input aria-label="repository path" list="recent-repositories" value={repositoryPath} onChange={(event) => setRepository(event.target.value)} /></label>
        <button className="button" disabled={picking} type="button" onClick={() => { void browse(); }}>{picking ? "choose the folder in the window that opened" : "browse…"}</button>
      </div>
      <datalist id="recent-repositories">{recentRepositories().map((path) => <option key={path} value={path} />)}</datalist>
      <p className="field__hint">The project folder to read: browse to it or paste its full path; folders you ran before are offered as you type. The run reads a snapshot of it and never modifies it, in any mode.</p>
      {pickFailure === null ? null : <p className="state" data-state="degraded" role="alert">{pickFailure}</p>}
    </Section>

    <Section title={`what to run · ${MODE_LABELS[mode]}`} id="what">
      <p className="note">The mode comes from the starting point. To run another mode, start from one of its templates.</p>
      {mode === "audit" ? <AuditFields draft={draft} edit={edit} setDraft={setDraft} listing={listing.value} />
        : mode === "feature" ? <FeatureFields draft={draft} edit={edit} />
        : <TestingFields draft={draft} edit={edit} />}
      <ScopeFields draft={draft} edit={edit} setDraft={setDraft} />
    </Section>

    <ModelsSection draft={draft} edit={edit} offered={offered} machine={<MachineModels environment={environment} failure={environmentFailure} onRefresh={() => loadEnvironment(true)} />} onUseModels={() => navigate({ page: "new-run", from: "template:subscription-audit", graph: null }, { replace: true })} />

    <AdvancedSection draft={draft} edit={edit} setDraft={setDraft} />

    <Section title="check and start" id="start-run">
      {open.length === 0 ? null : <div className="state" data-state="attention"><p>{open.length === 1 ? "1 value still needs filling in" : `${open.length} values still need filling in`}:</p><ul aria-label="placeholders to fill in" className="plain-list">{open.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>}
      <div className="actions"><button className="button" disabled={busy !== null} type="button" onClick={() => { void runCheck(); }}>{busy === "checking" ? "checking" : "check configuration"}</button></div>
      {check === null ? null : <CheckResult result={check.result} stale={stale} limit={getIn(draft, TOKEN_LIMIT)} onUseLimit={(value) => { autoLimit.current = value; edit(TOKEN_LIMIT, value); }} />}
      <label className="field">save as<input aria-label="configuration name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p className="field__hint">{updating ? `Saving updates the saved configuration “${loaded?.name ?? ""}”.` : "Saving creates a new saved configuration under this name."} A run always starts from a saved configuration.</p>
      <div className="actions">
        <button className="button" disabled={busy !== null || name.trim() === ""} type="button" onClick={() => { void save(); }}>{updating ? "save changes" : "save"}</button>
        <button className="button button--primary" disabled={busy !== null || name.trim() === ""} type="button" onClick={() => { void start(); }}>{busy === "starting" ? "starting" : updating ? "save changes and start" : "save and start"}</button>
      </div>
      {check !== null && !check.result.ready && !stale ? <p className="note">Starting needs a configuration that passes preflight; fix the problems above first.</p> : null}
      {notice === null ? null : <p className="state" data-state="verified" role="status">{notice}</p>}
      {failure.length === 0 ? null : <div className="state" data-state="refuted" role="alert">{failure.map((line) => <p key={line}>{line}</p>)}</div>}
    </Section>
  </div>;
}

const RECENT_REPOSITORIES = "arbitra.recentRepositories";

/** The folders this browser started runs on, newest first; a convenience, so storage that fails is ignored. */
function recentRepositories(): readonly string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(RECENT_REPOSITORIES) ?? "[]"); return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
  catch { return []; }
}
function rememberRepository(path: string): void {
  if (path.trim() === "") return;
  try { localStorage.setItem(RECENT_REPOSITORIES, JSON.stringify([path, ...recentRepositories().filter((entry) => entry !== path)].slice(0, 8))); } catch { /* not kept */ }
}

function Section({ title, id, children }: { readonly title: string; readonly id: string; readonly children: ReactNode }): ReactElement {
  return <section aria-labelledby={`${id}-title`} className="surface form-section"><h2 className="panel-title" id={`${id}-title`}>{title}</h2>{children}</section>;
}

type Edit = (path: readonly string[], value: unknown) => void;

function AuditFields({ draft, edit, setDraft, listing }: { readonly draft: Draft; readonly edit: Edit; readonly setDraft: (next: Draft) => void; readonly listing: GraphListing | null }): ReactElement {
  const preset = presetOf(draft);
  const saved = graphOf(draft);
  const templates = listing?.templates ?? [];
  const graphs = listing?.graphs ?? [];
  const value = saved === null ? `preset:${preset ?? ""}` : `graph:${saved.id}:${saved.version}`;
  const shape = saved !== null ? `Saved graph ${saved.id} @ ${saved.version.slice(0, 12)}.` : shapeOf(preset ?? "") ?? "An unknown preset; preflight will say whether it exists.";
  const pipeline = saved === null ? templates.find(({ id }) => id === (EARLIER_PRESETS[preset ?? ""] ?? preset)) : undefined;
  const presets = templates.length === 0 ? Object.keys(PRESET_SHAPES) : templates.map(({ id }) => id);
  if (preset !== null && saved === null && !presets.includes(preset)) presets.push(preset);
  const checkpoints = getIn(draft, ["workflow", "checkpoints", "mode"]);
  const scripted = Object.keys(record(draft["models"])).length === 0;
  return <>
    <label className="field">workflow
      <select aria-label="workflow" value={value} onChange={(event) => { const [kind, id, version] = event.target.value.split(":"); if (kind === "preset" && id !== undefined) setDraft(withPreset(draft, id)); if (kind === "graph" && id !== undefined && version !== undefined) setDraft(withGraph(draft, { id, version })); }}>
        <optgroup label="presets">{presets.map((id) => <option key={id} value={`preset:${id}`}>{id}</option>)}</optgroup>
        {graphs.length === 0 ? null : <optgroup label="saved graphs">{graphs.flatMap(({ graphId, versions }) => versions.map(({ version }) => <option key={`${graphId}:${version}`} value={`graph:${graphId}:${version}`}>{graphId} @ {version.slice(0, 12)}</option>))}</optgroup>}
      </select>
    </label>
    <p className="field__hint">{shape}{pipeline === undefined ? "" : ` Steps: ${describePipeline(pipeline)}.`}</p>
    <div className="field-row">
      <label className="field">peer review
        <select aria-label="peer review" value={String(draft["consensusPolicy"] ?? "risk_weighted")} onChange={(event) => edit(["consensusPolicy"], event.target.value)}>{CONSENSUS.map(([key]) => <option key={key} value={key}>{key.replace("_", "-")}</option>)}</select>
      </label>
      <label className="field">review rounds<input aria-label="review rounds" max={3} min={0} type="number" value={Number(draft["maxConsensusRounds"] ?? 1)} onChange={(event) => edit(["maxConsensusRounds"], Number(event.target.value))} /></label>
      <label className="field">audit depth
        <select aria-label="audit depth" value={String(draft["auditDepth"] ?? "balanced")} onChange={(event) => edit(["auditDepth"], event.target.value)}>{DEPTH.map(([key, text]) => <option key={key} value={key}>{key} · {text}</option>)}</select>
      </label>
    </div>
    <p className="field__hint">Peer review: {CONSENSUS.find(([key]) => key === draft["consensusPolicy"])?.[1] ?? "unknown policy"}. Disputed issues get another round, up to the limit (0 to 3). Depth is the effort requested from the models{scripted ? "; scripted detectors ignore it" : ". A model audit runs its plan critic at depth deep or when it plans a critical or high security issue, and otherwise records it as not required"}.</p>
    <label className="field">checkpoints
      <select aria-label="checkpoints" value={typeof checkpoints === "string" ? checkpoints : ""} onChange={(event) => edit(["workflow", "checkpoints"], event.target.value === "" ? undefined : { mode: event.target.value })}>
        <option value="">none</option><option value="interactive">interactive · stop for your decision</option><option value="automatic">automatic · decide from the configuration</option>
      </select>
    </label>
    <p className="field__hint">Interactive stops for your decision at a graph's human and gate nodes, and lets a model-backed Audit wait for your answers when its plan leaves a blocking question open; otherwise that question fails the gate. Preflight says when a graph needs a policy.</p>
  </>;
}

function FeatureFields({ draft, edit }: { readonly draft: Draft; readonly edit: Edit }): ReactElement {
  const decision = String(getIn(draft, ["workflow", "feature", "mode"]) ?? "interactive");
  return <>
    <label className="field">feature request<textarea aria-label="feature request" rows={4} value={String(getIn(draft, ["workflow", "feature", "request"]) ?? "")} onChange={(event) => edit(["workflow", "feature", "request"], event.target.value)} /></label>
    <p className="field__hint">What to build, in your words. The requirements model turns it into a contract you can inspect.</p>
    <div className="field-row">
      <label className="field">defaults
        <select aria-label="defaults" value={decision} onChange={(event) => edit(["workflow", "feature", "mode"], event.target.value)}><option value="interactive">interactive · you approve high-impact defaults</option><option value="automatic">automatic · proposed defaults are accepted</option></select>
      </label>
      <label className="field">requirement revisions<input aria-label="requirement revisions" max={3} min={0} type="number" value={Number(getIn(draft, ["workflow", "feature", "maximumRequirementsRevisions"]) ?? 1)} onChange={(event) => edit(["workflow", "feature", "maximumRequirementsRevisions"], Number(event.target.value))} /></label>
    </div>
  </>;
}

function TestingFields({ draft, edit }: { readonly draft: Draft; readonly edit: Edit }): ReactElement {
  const execute = getIn(draft, ["workflow", "testing", "mode"]) === "execute";
  return <>
    <label className="field">testing goal<textarea aria-label="testing goal" rows={3} value={String(getIn(draft, ["workflow", "testing", "goal"]) ?? "")} onChange={(event) => edit(["workflow", "testing", "goal"], event.target.value)} /></label>
    <p className="field__hint">The behaviour the new tests must protect.</p>
    <p className="state" data-state={execute ? "attention" : "unexamined"}>{execute ? "writes and runs tests in a Docker sandbox under the write grants and checks in the configuration (see the JSON under advanced); the repository is never modified" : "plans tests only; nothing is written or run"}</p>
  </>;
}

function ScopeFields({ draft, edit, setDraft }: { readonly draft: Draft; readonly edit: Edit; readonly setDraft: (next: Draft) => void }): ReactElement {
  const scope = record(draft["scope"]);
  const kind = String(scope["kind"] ?? "repository");
  return <fieldset className="scope">
    <legend className="panel-title">scope</legend>
    <label className="field">what to read
      <select aria-label="scope" value={kind} onChange={(event) => setDraft(withScopeKind(draft, event.target.value))}><option value="repository">the whole repository</option><option value="module">some directories</option><option value="diff">a diff</option></select>
    </label>
    {kind !== "module" ? null : <LinesField label="directories, one per line" name="modules" rows={3} values={scope["modules"]} onChange={(values) => edit(["scope", "modules"], values)} />}
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
    <LinesField label="leave out (path prefixes, one per line)" name="excluded paths" rows={2} values={scope["exclude"]} onChange={(values) => edit(["scope", "exclude"], values)} />
  </fieldset>;
}

/**
 * A list edited as lines. The text is what the operator typed, blank lines and all; the
 * configuration gets the parsed list. It re-reads the configuration only when the list there
 * changes to something the text does not already say (another starting point, the JSON).
 */
function LinesField({ label, name, rows, values, onChange }: { readonly label: string; readonly name: string; readonly rows: number; readonly values: unknown; readonly onChange: (values: readonly string[] | undefined) => void }): ReactElement {
  const listed = Array.isArray(values) ? values.map(String) : [];
  const [text, setText] = useState(listed.join("\n"));
  const parsed = lines(text) ?? [];
  if (parsed.join("\n") !== listed.join("\n") && document.activeElement?.getAttribute("aria-label") !== name) setText(listed.join("\n"));
  return <label className="field">{label}<textarea aria-label={name} rows={rows} value={text} onChange={(event) => { setText(event.target.value); onChange(lines(event.target.value)); }} /></label>;
}

function ModelsSection({ draft, edit, offered, machine, onUseModels }: { readonly draft: Draft; readonly edit: Edit; readonly offered: OfferedModels; readonly machine: ReactElement; readonly onUseModels: () => void }): ReactElement {
  const profiles = modelProfiles(draft);
  const aliases = profiles.map(({ alias }) => alias);
  if (profiles.length === 0) return <Section title="models" id="models">
    {machine}
    <p className="state" data-state="unexamined">no models · the auditors are deterministic detectors</p>
    <p><button className="button button--primary" type="button" onClick={onUseModels}>audit with the subscription CLIs instead</button></p>
    <p className="prose">This run calls no model and spends nothing. It shows the pipeline works; it is not evidence about what models find. To audit with models, start from one of the model-backed templates.</p>
  </Section>;
  const recommendable = profiles.filter((profile) => profile.placeholder && offeredCatalog(profile.transport, offered) !== undefined);
  return <Section title="models" id="models">
    {machine}
    <p className="note">Each profile names a model on an endpoint. Choose a model for each, or use the recommended ones; choosing one also sets its family and tier. The credentials themselves stay with the CLI or in the environment variables the endpoints name.</p>
    {recommendable.length === 0 ? null : <p><button className="button" type="button" onClick={() => { for (const profile of recommendable) { const choice = offeredCatalog(profile.transport, offered)?.[0]; if (choice !== undefined) choose(edit, profile.alias, choice); } }}>
      use the recommended models · {recommendable.map((profile) => modelName(offeredCatalog(profile.transport, offered)?.[0]?.modelId ?? "")).join(", ")}</button></p>}
    <p className="note">Effort per stage: {EFFORT_STAGES.map(({ label, stage }) => `${label} ${[...new Set(profiles.filter(({ roles }) => roles.some((role) => stage === "discovery" ? role.label.startsWith("auditor") : role.node === stage)).map(({ alias }) => effortFor(draft, alias, stage === "verification" ? "verification" : stage)))].join("/") || "-"}`).join(" · ")}. Audit depth sets the auditors&apos; effort; the later stages run at their own, usually lower, effort. Higher effort finds more and takes longer and more of your plan&apos;s usage.</p>
    <div className="table-scroll"><table aria-label="model profiles" className="table">
      <thead><tr><th scope="col">profile</th><th scope="col">provider · transport</th><th scope="col">model</th><th scope="col">family</th><th scope="col">tier · independence</th><th scope="col">roles · effort</th></tr></thead>
      <tbody>{profiles.map((profile) => <tr data-placeholder={profile.placeholder} key={profile.alias}>
        <td>{profile.alias}</td>
        <td>{profile.provider} · {profile.transport}</td>
        <ModelChoice profile={profile} edit={edit} catalog={offeredCatalog(profile.transport, offered)} />
        <td>{profile.capabilityTier} · {profile.independenceGroup}</td>
        <td>{profile.roles.map(({ label, node }) => { const effort = roleEffort(draft, profile.alias, node); return effort === null ? label : `${label} · ${effort}`; }).join(", ") || "none"}</td>
      </tr>)}</tbody>
    </table></div>
    <RoleFields draft={draft} edit={edit} aliases={aliases} />
    {getIn(draft, ["workflow", "modelExecution"]) === undefined ? null : <div className="field-row limits">{LIMITS.map((limit) => <label className="field" key={limit.label}>{limit.label}
      <input aria-label={limit.label} min={0} type="number" value={Number(getIn(draft, limit.path) ?? 0)} onChange={(event) => edit(limit.path, event.target.value === "" ? undefined : Number(event.target.value))} />
      <span className="field__hint">{limit.hint}</span>
    </label>)}</div>}
    {getIn(draft, ["mode"]) !== "audit" ? null : <fieldset className="scope"><legend>verification</legend>
      <label className="operator-check"><input aria-label="verify only the issues the plan covers" checked={getIn(draft, ["verification", "belowPlanScope"]) === "skip"} type="checkbox" onChange={(event) => edit(["verification", "belowPlanScope"], event.target.checked ? "skip" : undefined)} />
        verify only the issues the plan covers{typeof getIn(draft, ["workflow", "modelExecution", "planScope", "minimumSeverity"]) === "string" ? ` (${String(getIn(draft, ["workflow", "modelExecution", "planScope", "minimumSeverity"]))} and up)` : " (needs a plan minimum severity)"}</label>
      <p className="field__hint">Issues below it get no task, so they keep the peer vote and show as not verified. Saves about a third of a run&apos;s tokens.</p>
      <label className="operator-check"><input aria-label="re-ask merged issues at every place, also within one file" checked={getIn(draft, ["verification", "reaskMergedPlaces"]) === "always"} type="checkbox" onChange={(event) => edit(["verification", "reaskMergedPlaces"], event.target.checked ? "always" : undefined)} />
        re-ask a rejected merged issue at every place, also when its places are in one file</label>
      <p className="field__hint">Off, a rejected merged issue is re-asked place by place only when its places are in different files. Within one file it took 10 to 16% of a run&apos;s tokens and confirmed 7 of 50, none of them a planted defect.</p>
      <label className="operator-check"><input aria-label="ask a second model before rejecting a severe issue" checked={getIn(draft, ["verification", "secondOpinion"]) === "severe_rejections"} type="checkbox" onChange={(event) => edit(["verification", "secondOpinion"], event.target.checked ? "severe_rejections" : undefined)} />
        ask a second model before rejecting a critical or high issue a reviewer backed</label>
      <p className="field__hint">When the two disagree the issue stays open, and the saved plan has a prompt to check it. Costs one more question per such issue.</p>
    </fieldset>}
  </Section>;
}

const OTHER_MODEL = "other";

function choose(edit: Edit, alias: string, model: CatalogModel): void {
  for (const [path, value] of modelSettings(model)) edit(["models", alias, ...path], value);
}

/**
 * A profile's model chosen from the models known for its transport, so an ID cannot be mistyped. "Another model ID"
 * opens a typed ID and family for a model not listed; a transport with no list (an OpenAI-compatible endpoint) is typed.
 */
function ModelChoice({ profile, edit, catalog }: { readonly profile: ModelProfileSummary; readonly edit: Edit; readonly catalog: readonly CatalogModel[] | undefined }): ReactElement {
  const known = catalog?.find(({ modelId }) => modelId === profile.modelId);
  const unset = profile.modelId.startsWith(PLACEHOLDER_PREFIX);
  const [otherChosen, setOtherChosen] = useState(false);
  const typed = catalog === undefined || (known === undefined && (!unset || otherChosen));
  const typedId = (value: string): void => {
    edit(["models", profile.alias, "modelId"], value);
    const match = catalog?.find(({ modelId }) => modelId === value);
    if (match !== undefined) choose(edit, profile.alias, match);
  };
  return <>
    <td className="model-choice">
      {catalog === undefined ? null : <select aria-label={`model for ${profile.alias}`} className={!typed && unset ? "placeholder" : undefined} value={typed ? OTHER_MODEL : known?.modelId ?? ""}
        onChange={(event) => { const model = catalog.find(({ modelId }) => modelId === event.target.value); setOtherChosen(model === undefined); if (model !== undefined) choose(edit, profile.alias, model); }}>
        <option disabled value="">choose a model</option>
        {catalog.map((model, index) => <option key={model.modelId} value={model.modelId}>{modelName(model.modelId)}{index === 0 ? " (recommended)" : ""}{model.note === "" ? "" : ` · ${model.note}`}</option>)}
        <option value={OTHER_MODEL}>another model ID…</option>
      </select>}
      {typed ? <input aria-label={`model ID for ${profile.alias}`} className={unset ? "placeholder" : undefined} value={profile.modelId} onChange={(event) => typedId(event.target.value)} /> : null}
    </td>
    <td>{typed ? <input aria-label={`family for ${profile.alias}`} className={profile.family.startsWith(PLACEHOLDER_PREFIX) ? "placeholder" : undefined} value={profile.family} onChange={(event) => edit(["models", profile.alias, "family"], event.target.value)} /> : profile.family}</td>
  </>;
}

const EFFORT_STAGES = [{ label: "auditors", stage: "discovery" }, { label: "verification", stage: "verification" }, { label: "plan", stage: "planner" }, { label: "critic", stage: "critic" }] as const;

interface DetectedCli { readonly transport: string; readonly name: string; readonly state: string; readonly version: string | null; readonly note: string; readonly fix: string | null; readonly models?: readonly { readonly id: string; readonly name: string }[]; readonly caution?: string }
interface DetectedEnvironment { readonly build: string; readonly clis: readonly DetectedCli[]; readonly apiKeys: Readonly<Record<string, boolean>> }

/** The models this machine can run, found without a model call, with what to do about any that cannot run. */
function offeredModels(environment: DetectedEnvironment | null): OfferedModels {
  return Object.fromEntries((environment?.clis ?? []).flatMap(({ transport, models }) => models === undefined ? [] : [[transport, models]]));
}

function MachineModels({ environment, failure, onRefresh }: { readonly environment: DetectedEnvironment | null; readonly failure: string | null; readonly onRefresh: () => void }): ReactElement {
  if (failure !== null) return <p className="state" data-state="degraded">models on this machine could not be checked · {failure}</p>;
  if (environment === null) return <p className="state" data-state="unexamined">checking the models on this machine</p>;
  const keys = Object.entries(environment.apiKeys).filter(([, set]) => set).map(([name]) => name);
  return <div className="machine-models" aria-label="models on this machine">
    <h3 className="panel-title">on this machine</h3>
    <ul className="plain-list">{environment.clis.map((cli) => <li className="state" data-state={cli.state === "ready" ? "verified" : "degraded"} key={cli.name}>
      {cli.name}{cli.version === null ? "" : ` ${cli.version}`} · {cli.state === "ready" ? "ready" : cli.state.replaceAll("_", " ")} · {cli.note}{cli.fix === null ? null : <span className="field__hint"> {cli.fix}</span>}{cli.caution === undefined ? null : <span className="field__hint"> {cli.caution}</span>}
    </li>)}
      <li className="state" data-state={keys.length === 0 ? "unexamined" : "verified"}>API keys · {keys.length === 0 ? "none set (subscription CLIs need none)" : keys.join(", ")}</li></ul>
    <button className="link-button" type="button" onClick={onRefresh}>check again</button>
  </div>;
}

function RoleFields({ draft, edit, aliases }: { readonly draft: Draft; readonly edit: Edit; readonly aliases: readonly string[] }): ReactElement | null {
  const slots = roleSlots(draft);
  if (slots.length === 0) return null;
  return <fieldset className="roles"><legend className="panel-title">roles</legend><div className="field-row">{slots.map((slot) => <RoleField key={slot.label} slot={slot} draft={draft} edit={edit} aliases={aliases} />)}</div></fieldset>;
}

function RoleField({ slot, draft, edit, aliases }: { readonly slot: RoleSlot; readonly draft: Draft; readonly edit: Edit; readonly aliases: readonly string[] }): ReactElement {
  const value = getIn(draft, slot.path);
  if (slot.multiple) {
    const chosen = Array.isArray(value) ? value.map(String) : [];
    return <fieldset className="field role-multiple"><legend>{slot.label}</legend>{aliases.map((alias) => <label className="operator-check" key={alias}><input checked={chosen.includes(alias)} type="checkbox" onChange={() => edit(slot.path, chosen.includes(alias) ? chosen.filter((item) => item !== alias) : [...chosen, alias])} />{alias}</label>)}<span className="field__hint">{slot.hint}</span></fieldset>;
  }
  return <label className="field">{slot.label}
    <select aria-label={`${slot.label} role`} value={typeof value === "string" ? value : ""} onChange={(event) => edit(slot.path, event.target.value === "" ? undefined : event.target.value)}>
      <option value="">{slot.optional ? "none" : "choose a profile"}</option>{aliases.map((alias) => <option key={alias} value={alias}>{alias}</option>)}
    </select>
    <span className="field__hint">{slot.hint}</span>
  </label>;
}

function AdvancedSection({ draft, edit, setDraft }: { readonly draft: Draft; readonly edit: Edit; readonly setDraft: (next: Draft) => void }): ReactElement {
  const formatted = useMemo(() => JSON.stringify(draft, null, 2), [draft]);
  const [text, setText] = useState(formatted);
  const [error, setError] = useState<string | null>(null);
  // The configuration the JSON edits started from; null while the JSON simply follows the form.
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => { if (base === null) setText(formatted); }, [formatted, base]);
  const stale = base !== null && base !== formatted;
  const apply = (): void => {
    // Applying edits made over an older configuration would silently undo the form's changes.
    if (stale) { setError("the form changed after these JSON edits began; discard them and edit again"); return; }
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the configuration must be a JSON object");
      setBase(null); setError(null); setDraft(value as Draft);
    } catch (cause) { setError(message(cause)); }
  };
  return <section aria-labelledby="advanced-title" className="surface form-section">
    <details className="advanced">
      <summary><h2 className="panel-title" id="advanced-title">advanced · harness and the full configuration</h2></summary>
      <div className="form-section">
        <label className="field">harness
          <select aria-label="harness" value={String(getIn(draft, ["harness", "mode"]) ?? "canonical")} onChange={(event) => edit(["harness", "mode"], event.target.value)}><option value="canonical">canonical · the same tool loop for every model</option><option value="native">native · the vendor's own agent (Testing writer only)</option></select>
        </label>
        <p className="field__hint">Each model already runs in its own vendor&apos;s CLI, with prompts in the style that model reads best. The harness only decides who runs the tool loop while the models read the code: arbitra&apos;s own, the same for every model, so that independent findings can be compared. A vendor&apos;s own agent is allowed only for writing tests.</p>
        <p className="field__hint"><code>budgets</code>, <code>security</code> and <code>contextPolicies</code> are not enforced by the runtime; preflight warns when they are set. Spend is limited by the model limits above.</p>
        <label className="field">configuration JSON · {base === null ? "exactly what will be saved" : "edited, not yet applied"}<textarea aria-label="configuration JSON" rows={18} spellCheck={false} value={text} onChange={(event) => { if (base === null) setBase(formatted); setText(event.target.value); }} /></label>
        {stale ? <p className="state" data-state="degraded" role="status">the form changed after these JSON edits began · applying them is refused</p> : null}
        <div className="actions">
          <button className="button" disabled={base === null} type="button" onClick={apply}>apply JSON</button>
          <button className="button" disabled={base === null} type="button" onClick={() => { setBase(null); setError(null); setText(formatted); }}>discard JSON edits</button>
        </div>
        {error === null ? null : <p className="state" data-state="refuted" role="alert">not applied · {error}</p>}
      </div>
    </details>
  </section>;
}

const TOKEN_LIMIT = ["workflow", "modelExecution", "maximumTokens"] as const;

function CheckResult({ result, stale, limit, onUseLimit }: { readonly result: PreflightResult; readonly stale: boolean; readonly limit: unknown; readonly onUseLimit: (value: number) => void }): ReactElement {
  const errors = result.diagnostics.filter(({ severity }) => severity === "error");
  const warnings = result.diagnostics.filter(({ severity }) => severity === "warning");
  const estimate = result.estimate?.estimate ?? null;
  return <div aria-label="check result" className="check" role="region">
    {stale ? <p className="state" data-state="unexamined">the configuration changed after this check · check it again</p> : null}
    <p className="state" data-state={result.ready ? "verified" : "refuted"}>{result.ready ? "ready to start" : !result.valid ? `not valid · ${errors.length} ${errors.length === 1 ? "problem" : "problems"} in the configuration` : `valid, but this machine is not ready · ${errors.length} ${errors.length === 1 ? "problem" : "problems"}`}</p>
    <p className="data">{result.modelBacked === null ? "model use unknown until the configuration is valid" : result.modelBacked ? "calls models" : "calls no model · scripted detectors"} · reads {result.repository}</p>
    {result.diagnostics.length === 0 ? null : <ul aria-label="preflight diagnostics" className="plain-list diagnostics">{[...errors, ...warnings].map((item, index) => <li className="state" data-state={item.severity === "error" ? "refuted" : "degraded"} key={`${item.code}-${item.path}-${index}`}>
      <p className="data">{item.severity} · <code>{item.code}</code> · {item.scope === "environment" ? "this machine" : <code>{item.path}</code>}</p>
      <p className="note">{item.message}</p>
    </li>)}</ul>}
    {estimate === null ? result.estimateError === null ? null : <p className="state" data-state="degraded">estimate unavailable · {result.estimateError}</p> : <dl aria-label="estimate" className="facts">
      <div><dt>files read</dt><dd>{estimate.files} files · {estimate.lines} lines</dd></div>
      <div><dt>workflow</dt><dd>{estimate.nodes} steps · {estimate.auditors} auditors</dd></div>
      <div><dt>model calls</dt><dd>{estimate.providerCalls === null ? "not known before the run" : estimate.providerCalls}</dd></div>
      {typeof limit !== "number" ? null : <div><dt>token limit</dt><dd>{tokens(limit)}{recommendedTokenLimit(estimate.lines, estimate.auditors) === limit ? " · set for this project's size" : <> · {tokens(recommendedTokenLimit(estimate.lines, estimate.auditors))} recommended for this size <button className="link-button" type="button" onClick={() => onUseLimit(recommendedTokenLimit(estimate.lines, estimate.auditors))}>use it</button></>}</dd></div>}
      <div><dt>cost</dt><dd>{estimate.costUsd === null ? "unavailable · no pricing is configured" : `${estimate.costUsd} ${estimate.currency ?? "USD"}`}</dd></div>
      <div><dt>basis</dt><dd>{estimate.basis.replaceAll("_", " ")}</dd></div>
    </dl>}
  </div>;
}

/** Load a starting point named by the address: a template, a saved configuration, a past run or a saved graph. */
async function startingPoint(from: string | null, graph: string | null, apis: ReturnType<typeof useApis>): Promise<Loaded> {
  if (from?.startsWith("config:") === true) {
    const stored = await apis.configurations.load<Draft>(from.slice("config:".length));
    return { draft: stored.config, name: stored.name, savedId: stored.id, source: `saved configuration ${stored.name}` };
  }
  if (from?.startsWith("run:") === true) {
    const runId = from.slice("run:".length);
    const overview = await apis.runs.overview(runId);
    // A scripted Audit stores no configuration; its preset, scope and review settings are enough to repeat it.
    const draft = overview.configuration ?? { ...SCRIPTED_AUDIT, scope: overview.scope, consensusPolicy: overview.consensusPolicy, maxConsensusRounds: overview.maximumRounds,
      workflow: overview.workflowGraph === null ? { preset: overview.workflowId ?? "audit-three-finders" } : { graph: overview.workflowGraph, ...(overview.checkpointMode === null ? {} : { checkpoints: { mode: overview.checkpointMode } }) } };
    // A rerun reads the repository its run read, not whatever the control plane now defaults to.
    return { draft, name: `rerun of ${runId.slice(0, 12)}`, savedId: null, source: `the settings run ${runId} was created with`, ...(overview.repository === null ? {} : { repository: overview.repository }) };
  }
  if (from === null && graph !== null) {
    const [id, version] = graph.split("@");
    if (id === undefined || version === undefined || id === "" || version === "") throw new Error(`GRAPH_REFERENCE_INVALID:${graph}`);
    const draft = withGraph(setIn(SCRIPTED_AUDIT, ["workflow", "checkpoints"], { mode: "interactive" }), { id, version });
    return { draft, name: suggestedName("graph", draft), savedId: null, source: `saved graph ${id} @ ${version}` };
  }
  const template = TEMPLATES.find(({ id }) => `template:${id}` === (from ?? DEFAULT_START)) ?? TEMPLATES[0];
  if (template === undefined) throw new Error("NO_TEMPLATES");
  return { draft: template.config, name: suggestedName(template.id, template.config), savedId: null, source: template.label };
}

function describeStart(key: string, loaded: Loaded | null): string {
  const template = TEMPLATES.find(({ id }) => key === `template:${id}`);
  if (template !== undefined) return template.description;
  if (loaded === null) return "Loading the starting point.";
  if (key.startsWith("config:")) return `Saved configuration “${loaded.name}”. Saving updates it unless you change the name.`;
  return `Starting from ${loaded.source}.`;
}

function describePipeline(graph: AuthoredGraph): string {
  const incoming = new Map(graph.nodes.map(({ id }) => [id, graph.edges.filter(({ to }) => to === id).length]));
  const layers: string[][] = [];
  let frontier = graph.nodes.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id);
  const seen = new Set<string>();
  while (frontier.length > 0 && layers.length < graph.nodes.length) {
    layers.push(frontier.map((id) => graph.nodes.find((node) => node.id === id)?.label ?? id));
    for (const id of frontier) seen.add(id);
    frontier = [...new Set(graph.edges.filter(({ from }) => frontier.includes(from)).map(({ to }) => to))].filter((id) => !seen.has(id) && graph.edges.filter(({ to }) => to === id).every(({ from }) => seen.has(from)));
  }
  return layers.map((layer) => layer.join(", ")).join(" → ");
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
