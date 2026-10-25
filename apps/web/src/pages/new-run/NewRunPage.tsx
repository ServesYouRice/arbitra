import "./new-run.css";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useConfigurations } from "../../api/configurations.js";
import type { PreflightDiagnostic, PreflightResult } from "../../api/runs.js";
import { useLoaded } from "../../api/runs.js";
import type { GraphListing } from "../../api/workflows.js";
import { useApis } from "../../app/apis.js";
import { recommendedTokenLimit } from "../../app/token-limit.js";
import { useNavigation } from "../../app/router.js";
import { counted } from "../../app/words.js";
import { stableJson } from "../../graph/editor-model.js";
import { modelProfiles, record } from "../run/models.js";
import { withStrongestOffered } from "./model-catalog.js";
import { getIn, modeOf, placeholders, setIn, suggestedName, withGraph, type Draft, type Mode } from "./draft.js";
import { DEFAULT_START, SCRIPTED_AUDIT, TEMPLATES } from "./templates.js";
import { isSubscriptionAudit } from "./depth.js";
import { leftOut, reading, withPath } from "./reading.js";
import { HowThorough, PlanScope, StepsList } from "./HowThorough.js";
import { WhatToRead } from "./WhatToRead.js";
import { antigravityState, offeredModels, ThisComputer, type DetectedEnvironment } from "./ThisComputer.js";
import { ChangeModels } from "./ChangeModels.js";
import { MoreOptions, optionsSummary } from "./MoreOptions.js";
import { FeatureFields, TestingFields } from "./ModeFields.js";

const LEAVE = { title: "unsaved lineup", description: "This lineup has changes that are not saved. Leaving or choosing another lineup discards them." } as const;
const TOKEN_LIMIT = ["workflow", "modelExecution", "maximumTokens"] as const;
/** The check reads the project again this long after the last change, so typing a path does not read every prefix. */
const CHECK_DELAY_MS = 600;
const HEADING: Readonly<Record<Mode, string>> = Object.freeze({ audit: "New audit", feature: "New feature run", testing: "New testing run" });
const START: Readonly<Record<Mode, string>> = Object.freeze({ audit: "Start audit", feature: "Start feature run", testing: "Start testing run" });
/** The lineups the depth cards stand for: one choice there, not two entries in the list. */
const CARD_LINEUPS = new Set(["template:subscription-audit", "template:subscription-audit-gemini"]);

interface Loaded { readonly draft: Draft; readonly name: string; readonly savedId: string | null; readonly source: string; readonly repository?: string }
/** A check of one lineup against one project; `key` is what it checked, so the page knows when to check again. */
interface Checked { readonly result: PreflightResult; readonly key: string; readonly repository: string; readonly draft: Draft }

const excludeOf = (draft: Draft): readonly string[] => { const value = getIn(draft, ["scope", "exclude"]); return Array.isArray(value) ? value.map(String) : []; };
const withExclude = (draft: Draft, exclude: readonly string[]): Draft => setIn(draft, ["scope", "exclude"], exclude.length === 0 ? undefined : [...exclude]);
/** What a check depends on. Leave-outs are counted on the page from the check's list of files, while that list is whole. */
const checkKey = (draft: Draft, repository: string, wholeList: boolean): string => stableJson({ repository, draft: wholeList ? withExclude(draft, []) : draft });
const projectName = (path: string): string => path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? path;

/**
 * Start a run on one page: the project, how thorough (a card per depth, with what each step uses and what a run will
 * use, from measured runs), the steps, what to read, what goes into the plan, and this computer. The check reads the
 * project as soon as it is chosen and again after each change; nothing runs until Start, which saves the lineup the
 * run starts from.
 */
export function NewRunPage({ from, graph }: { readonly from: string | null; readonly graph: string | null }): ReactElement {
  const apis = useApis();
  const { navigate, setGuard } = useNavigation();
  const { configurations, reload } = useConfigurations(apis.configurations);
  const listing = useLoaded<GraphListing>("workflows", () => apis.workflows.list());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(SCRIPTED_AUDIT);
  // The project starts empty: the server's own folder is not a project (inventory, October 25, 2026).
  const [repository, setRepository] = useState("");
  const [check, setCheck] = useState<Checked | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"saving" | "starting" | null>(null);
  const [failure, setFailure] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<DetectedEnvironment | null>(null);
  const [environmentFailure, setEnvironmentFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickFailure, setPickFailure] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  // Suggested leave-outs the person ticked back in: a later check does not leave them out again.
  const readAnyway = useRef(new Set<string>());
  const draftRef = useRef(draft); draftRef.current = draft;
  const loadedRef = useRef(loaded); loadedRef.current = loaded;
  const repositoryRef = useRef(repository); repositoryRef.current = repository;
  const ticket = useRef(0);
  // While Start checks the lineup, a check waiting for typing to pause does not run: it would make Start's stale.
  const starting = useRef(false);

  // The lineup is part of the address, so a template, a saved lineup or a rerun is a link.
  useEffect(() => {
    let active = true;
    setLoadError(null); setCheck(null); setFailure([]); setNotice(null); setNaming(null); readAnyway.current = new Set();
    void startingPoint(from, graph, apis).then((value) => { if (!active) return; setLoaded(value); setDraft(value.draft); if (value.repository !== undefined) setRepository(value.repository); }, (cause: unknown) => { if (active) setLoadError(message(cause)); });
    return () => { active = false; };
  }, [from, graph, apis]);

  const dirty = loaded !== null && stableJson(draft) !== stableJson(loaded.draft);
  const loadEnvironment = (refresh: boolean): void => {
    setEnvironmentFailure(null);
    void fetch(`/diagnostics/environment${refresh ? "?refresh=1" : ""}`).then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); setEnvironment(await response.json() as DetectedEnvironment); })
      .catch((error: unknown) => setEnvironmentFailure(message(error)));
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
  const project = repository.trim();
  // A fresh start leaves the generated files out; a saved lineup or a rerun keeps the leave-outs it has.
  const autoLeaveOut = !(from?.startsWith("config:") === true || from?.startsWith("run:") === true);

  // The check sizes the stop for the project unless it was set by hand: one still at the lineup's value, or at the
  // value an earlier check set.
  const autoLimit = useRef<number | null>(null);
  const sizedLimit = (current: Draft, lines: number, auditors: number): Draft => {
    const limit = getIn(current, TOKEN_LIMIT);
    if (typeof limit !== "number" || (limit !== getIn(loadedRef.current?.draft ?? {}, TOKEN_LIMIT) && limit !== autoLimit.current)) return current;
    const recommended = recommendedTokenLimit(lines, auditors);
    autoLimit.current = recommended;
    return recommended === limit ? current : setIn(current, TOKEN_LIMIT, recommended);
  };
  /** The lineup once a check has read the project: generated files left out (unless ticked back in), the stop sized. */
  const applyCheck = (result: PreflightResult, value: Draft): Draft => {
    let exclude = excludeOf(value);
    if (autoLeaveOut) for (const { path } of result.estimate?.suggestedLeaveOut ?? []) if (!readAnyway.current.has(path) && !leftOut(exclude, path)) exclude = withPath(exclude, path, true);
    let next = exclude.length === excludeOf(value).length ? value : withExclude(value, exclude);
    const estimate = result.estimate?.estimate;
    const files = result.estimate?.read?.files;
    if (estimate !== undefined) next = sizedLimit(next, files === undefined ? estimate.lines : reading(files, exclude).lines, estimate.auditors);
    return next;
  };
  const runCheck = async (): Promise<Checked | null> => {
    const path = repositoryRef.current.trim();
    if (path === "") return null;
    const value = draftRef.current;
    const current = ++ticket.current;
    setChecking(true); setCheckError(null);
    try {
      const result = await apis.runs.preflight(value, path);
      // A newer check, or a change made while this one read the project, is checked again.
      if (current !== ticket.current || draftRef.current !== value || repositoryRef.current.trim() !== path) return null;
      const next = applyCheck(result, value);
      // What the check sets is the lineup's own: it leaves an unedited page unedited.
      const start = loadedRef.current;
      if (next !== value && start !== null && stableJson(value) === stableJson(start.draft)) setLoaded({ ...start, draft: next });
      if (next !== value) { draftRef.current = next; setDraft(next); }
      const checked = { result, key: checkKey(next, path, result.estimate?.read?.complete === true), repository: path, draft: next };
      setCheck(checked);
      return checked;
    } catch (cause) {
      if (current === ticket.current) { setCheck(null); setCheckError(message(cause)); }
      return null;
    } finally { if (current === ticket.current) setChecking(false); }
  };
  const wholeList = check !== null && check.repository === project && check.result.estimate?.read?.complete === true;
  const key = project === "" || loaded === null ? null : checkKey(draft, project, wholeList);
  useEffect(() => {
    if (key === null || check?.key === key) return;
    const timer = setTimeout(() => { if (!starting.current) void runCheck(); }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key]);

  const result = check !== null && check.repository === project ? check.result : null;
  const fresh = result !== null && check?.key === key;
  const exclude = excludeOf(draft);
  const files = result?.estimate?.read?.files ?? null;
  const read = files === null ? null : reading(files, exclude);
  const lines = read?.lines ?? result?.estimate?.estimate.lines ?? null;
  const open = placeholders(draft);

  const save = async (name: string, target: Draft, update: string | null): Promise<string | null> => {
    setBusy("saving"); setFailure([]); setNotice(null);
    try {
      const saved = update !== null ? await apis.configurations.update(update, name, target) : await apis.configurations.save(name, target);
      void reload();
      return saved.id;
    } catch (cause) { setFailure([message(cause)]); return null; }
    finally { setBusy(null); }
  };
  const saveLineup = async (name: string): Promise<void> => {
    const update = loaded?.savedId != null && name === loaded.name ? loaded.savedId : null;
    const id = await save(name, draft, update);
    if (id === null) return;
    setLoaded({ draft, name, savedId: id, source: `saved lineup ${name}` });
    setNaming(null);
    setNotice(`saved as the lineup “${name}”`);
  };
  const startable = (checked: PreflightResult, value: Draft): boolean => checked.ready && placeholders(value).length === 0 && (checked.estimate?.read === undefined || reading(checked.estimate.read.files, excludeOf(value)).lines > 0);
  const start = async (): Promise<void> => {
    setFailure([]); setNotice(null);
    starting.current = true;
    const checked = await runCheck().finally(() => { starting.current = false; });
    if (checked === null || !startable(checked.result, checked.draft)) return;
    // A run starts from a saved lineup: the one loaded when it is unchanged, else this project's last start.
    const unchanged = loaded?.savedId != null && stableJson(checked.draft) === stableJson(loaded.draft);
    const lastStart = `last start · ${projectName(checked.repository)}`;
    const id = unchanged ? loaded.savedId : await save(lastStart, checked.draft, configurations.find(({ name }) => name === lastStart)?.id ?? null);
    if (id === null || id === undefined) return;
    setBusy("starting");
    try {
      const run = await apis.runs.start(id, checked.repository);
      rememberRepository(checked.repository);
      setGuard(null);
      navigate({ page: "run", runId: run.runId, tab: null, item: null });
    } catch (cause) { setFailure(message(cause).split("\n")); }
    finally { setBusy(null); }
  };
  const browse = async (): Promise<void> => {
    setPicking(true); setPickFailure(null);
    try { const { path } = await apis.runs.pickRepository(); if (path !== null) setRepository(path); }
    catch (cause) { setPickFailure(`The folder window could not open (${message(cause)}). Paste the folder's path instead.`); }
    finally { setPicking(false); }
  };
  const importFile = async (file: File): Promise<void> => {
    try {
      const value: unknown = JSON.parse(await file.text());
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the file is not a JSON object");
      setDraft(value as Draft); setNotice(`imported ${file.name}`);
    } catch (cause) { setFailure([`import failed · ${message(cause)}`]); }
  };
  const onSuggestion = (path: string, leave: boolean): void => {
    if (leave) readAnyway.current.delete(path); else readAnyway.current.add(path);
    setDraft((current) => withExclude(current, withPath(excludeOf(current), path, leave)));
  };

  const startKey = from ?? (graph === null ? DEFAULT_START : "graph");
  const subscription = isSubscriptionAudit(draft);
  const scripted = mode === "audit" && Object.keys(record(draft["models"])).length === 0;
  const transports = new Set(modelProfiles(draft).map(({ transport }) => transport));
  const usesApiKeys = ((getIn(draft, ["workflow", "modelExecution", "endpoints"]) ?? []) as readonly { readonly apiKeyEnvVar?: unknown }[]).some(({ apiKeyEnvVar }) => typeof apiKeyEnvVar === "string");
  const auditors = result?.estimate?.estimate.auditors ?? null;
  let step = 0;
  const number = (): number => { step += 1; return step; };

  return <div className="new-run">
    <div className="page-head"><div className="page-head__text">
      <h1 className="page-title">{HEADING[mode]}</h1>
      <p className="lead">{mode === "audit" ? "Pick a project and how thorough. arbitra reads the project and never changes it." : "Pick a project and say what to plan. arbitra reads the project and never changes it."}</p>
    </div></div>
    {loadError === null ? null : <p className="state" data-state="degraded" role="alert">The lineup could not be loaded · {loadError}</p>}
    {loaded === null ? loadError === null ? <p className="state" data-state="unexamined" role="status">loading the lineup</p> : null : <>

    <Section number={number()} title="Project" id="project">
      <div className="repository-row">
        <input aria-label="project folder" className="project-input" list="recent-projects" placeholder="the project's folder" spellCheck={false} value={repository} onChange={(event) => setRepository(event.target.value)} />
        <button className="button" disabled={picking} type="button" onClick={() => { void browse(); }}>{picking ? "choose the folder in the window that opened" : "Browse…"}</button>
      </div>
      <datalist id="recent-projects">{recentRepositories().map((path) => <option key={path} value={path} />)}</datalist>
      {recentRepositories().length === 0 ? null : <div className="recent"><span className="note">Recent</span>{recentRepositories().map((path) => <button className="button" key={path} title={path} type="button" onClick={() => setRepository(path)}>{projectName(path)}</button>)}</div>}
      <ProjectLine project={project} checking={checking && !fresh} error={checkError} result={result} read={read} />
      {pickFailure === null ? null : <p className="state" data-state="degraded" role="alert">{pickFailure}</p>}
    </Section>

    {mode === "audit" ? <Section number={number()} title="How thorough" id="thorough">
      {scripted ? <div className="lineup-cards"><div className="lineup-card" data-chosen="true">
        <span className="lineup-card__head"><span className="lineup-card__name">Scripted detectors</span><span className="lineup-card__tag">no model calls</span></span>
        <span className="lineup-card__when">Fixed detectors stand in for the finders. Nothing is spent: the run shows the steps work, not what models find.</span>
        <span><button className="button" type="button" onClick={() => navigate({ page: "new-run", from: DEFAULT_START, graph: null }, { replace: true })}>Audit with Claude Code and Codex instead</button></span>
      </div></div>
        : <HowThorough draft={draft} setDraft={setDraft} lines={lines} antigravity={antigravityState(environment)} />}
      <LineupChoice startKey={startKey} graph={graph} loaded={loaded} configurations={configurations} onChoose={(key) => navigate({ page: "new-run", from: key, graph: null }, { replace: true })} />
      <OpenValues open={open} />
      {scripted ? null : <details className="disclosure change-disclosure" open={open.length > 0 || !subscription}>
        <summary>Change models</summary>
        <ChangeModels draft={draft} edit={edit} offered={offered} />
      </details>}
    </Section> : <Section number={number()} title={mode === "feature" ? "What to plan" : "What to test"} id="what">
      {mode === "feature" ? <FeatureFields draft={draft} edit={edit} /> : <TestingFields draft={draft} edit={edit} />}
      <LineupChoice startKey={startKey} graph={graph} loaded={loaded} configurations={configurations} onChoose={(key) => navigate({ page: "new-run", from: key, graph: null }, { replace: true })} />
      <OpenValues open={open} />
      <details className="disclosure change-disclosure" open>
        <summary>Models</summary>
        <ChangeModels draft={draft} edit={edit} offered={offered} />
      </details>
    </Section>}

    {mode === "audit" && !scripted ? <Section number={number()} title="Steps" id="steps">
      <StepsList draft={draft} setDraft={setDraft} />
    </Section> : null}

    <Section number={number()} title="What to read" id="read">
      {files === null ? <p className="note">{project === "" ? "Choose the project to see its folders, its tests and what each holds of the estimate." : result?.estimate == null ? "The folders show once the project is read." : `${counted(result.estimate.estimate.files, "file")} · ${result.estimate.estimate.lines.toLocaleString("en")} lines`}</p>
        : <WhatToRead files={files} complete={result?.estimate?.read?.complete === true} suggestions={result?.estimate?.suggestedLeaveOut ?? []} exclude={exclude} onExclude={(next) => setDraft((current) => withExclude(current, next))} onSuggestion={onSuggestion} />}
    </Section>

    {mode === "audit" && !scripted ? <Section number={number()} title="What goes into the plan" id="plan-scope">
      <PlanScope draft={draft} setDraft={setDraft} />
    </Section> : null}

    <Section title="This computer" id="computer">
      <ThisComputer environment={environment} failure={environmentFailure} transports={transports} apiKeys={usesApiKeys} subscription={subscription} onRefresh={() => { loadEnvironment(true); void runCheck(); }} />
    </Section>

    <details className="disclosure more" id="more">
      <summary>More options · {optionsSummary(draft)}</summary>
      <MoreOptions draft={draft} edit={edit} setDraft={setDraft} listing={listing.value} recommendedLimit={lines === null || auditors === null ? null : recommendedTokenLimit(lines, auditors)}
        onUseLimit={(value) => { autoLimit.current = value; edit(TOKEN_LIMIT, value); }} onImport={(file) => { void importFile(file); }} />
    </details>

    <section aria-label="start" className="start-bar">
      <Readiness project={project} checking={checking || !fresh} error={checkError} result={fresh ? result : null} open={open} lines={read?.lines ?? null} />
      <div className="actions">
        <button className="button button--primary" disabled={busy !== null || project === ""} type="button" onClick={() => { void start(); }}>{busy === "starting" ? "starting" : busy === "saving" && naming === null ? "saving" : START[mode]}</button>
        {naming === null ? <button className="button" disabled={busy !== null} type="button" onClick={() => setNaming(loaded?.savedId != null ? loaded.name : `${project === "" ? "" : `${projectName(project)} · `}${String(draft["auditDepth"] ?? mode)}`)}>{loaded?.savedId != null ? `Save changes to “${loaded.name}”` : "Save as a lineup"}</button>
          : <span className="save-as">
            <label className="field">lineup name<input aria-label="lineup name" value={naming} onChange={(event) => setNaming(event.target.value)} /></label>
            <button className="button" disabled={busy !== null || naming.trim() === ""} type="button" onClick={() => { void saveLineup(naming.trim()); }}>save</button>
            <button className="link-button" type="button" onClick={() => setNaming(null)}>cancel</button>
          </span>}
        <span className="note">Nothing runs until you press Start.</span>
      </div>
      {notice === null ? null : <p className="state" data-state="verified" role="status">{notice}</p>}
      {failure.length === 0 ? null : <div className="state" data-state="refuted" role="alert">{failure.map((line) => <p key={line}>{line}</p>)}</div>}
    </section>
    </>}
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

function Section({ number, title, id, children }: { readonly number?: number; readonly title: string; readonly id: string; readonly children: ReactNode }): ReactElement {
  return <section aria-labelledby={`${id}-title`} className="form-section"><h2 className="panel-title" id={`${id}-title`}>{number === undefined ? title : `${number} · ${title}`}</h2>{children}</section>;
}

/** The project in one line once it is read: how much the run reads, or what stopped the reading, in words. */
function ProjectLine({ project, checking, error, result, read }: { readonly project: string; readonly checking: boolean; readonly error: string | null; readonly result: PreflightResult | null; readonly read: ReturnType<typeof reading> | null }): ReactElement | null {
  if (project === "") return null;
  if (error !== null) return <Problem words={readFailure(error, project)} code={error} />;
  if (result === null) return <p className="note" role="status">{checking ? "reading the project…" : ""}</p>;
  if (result.estimateError !== null) return <Problem words={readFailure(result.estimateError, project)} code={result.estimateError} />;
  const estimate = result.estimate?.estimate;
  if (estimate === undefined) return <p className="note">{checking ? "reading the project…" : "Read once the lineup is valid."}</p>;
  const files = read?.files ?? estimate.files; const lines = read?.lines ?? estimate.lines;
  return <p className="data project-line" role="status">{counted(files, "source file")} · {lines.toLocaleString("en")} lines{read === null || read.testLines === 0 ? "" : `, ${read.testLines.toLocaleString("en")} of them tests`}{checking ? " · reading again…" : ""}</p>;
}

/** What the check found in words, with the recorded code one click down. */
function Problem({ words, code, tone = "refuted" }: { readonly words: string; readonly code: string; readonly tone?: string }): ReactElement {
  return <div className="state problem-line" data-state={tone}><p>{words}</p><details><summary>recorded code</summary><code>{code}</code></details></div>;
}

/** Why the project could not be read, and what to do: the snapshot's refusals in words. */
export function readFailure(code: string, project: string): string {
  const files = /REPOSITORY_FILE_LIMIT_EXCEEDED:(\d+)/u.exec(code);
  if (files !== null) return `The project has more than ${Number(files[1]).toLocaleString("en")} source files, more than one run reads. Leave out folders, or read some folders only, under More options.`;
  const large = /REPOSITORY_FILE_TOO_LARGE:(\S+)/u.exec(code);
  if (large !== null) return `${large[1]} is larger than 512 KB, more than a run reads in one file. Leave it out under More options.`;
  if (/REPOSITORY_NOT_FOUND/u.test(code)) return `There is no folder at ${project}.`;
  if (/REPOSITORY_NOT_DIRECTORY/u.test(code)) return `${project} is a file, not a folder.`;
  if (/SCOPE_EXCLUSION_COVERS_REPOSITORY/u.test(code)) return "The leave-outs cover the whole project, so there is nothing to read.";
  if (/MODULE_SCOPE_EMPTY|MODULE_SCOPE_REQUIRED/u.test(code)) return "The folders to read hold no source file a run reads. Name others under More options.";
  if (/DIFF_REVISIONS_REQUIRED|INVALID_DIFF/u.test(code)) return "The diff needs a base and a head revision, under More options.";
  return "The project could not be read.";
}

/** The values a template leaves to fill in, by path: the check refuses a placeholder model. */
function OpenValues({ open }: { readonly open: readonly string[] }): ReactElement | null {
  if (open.length === 0) return null;
  return <div className="state" data-state="attention"><p>{open.length === 1 ? "1 value still needs filling in:" : `${open.length} values still need filling in:`}</p>
    <ul aria-label="placeholders to fill in" className="plain-list">{open.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>;
}

/** Whether the run can start, said once beside Start: what is missing, each problem in words with its code folded. */
function Readiness({ project, checking, error, result, open, lines }: { readonly project: string; readonly checking: boolean; readonly error: string | null; readonly result: PreflightResult | null; readonly open: readonly string[]; readonly lines: number | null }): ReactElement {
  if (project === "") return <p className="note">Choose the project first.</p>;
  if (error !== null) return <p className="state" data-state="refuted">Not ready: the project could not be read (above).</p>;
  if (result === null) return <p className="note" role="status">{checking ? "checking…" : ""}</p>;
  const errors = result.diagnostics.filter(({ severity }) => severity === "error");
  const warnings = result.diagnostics.filter(({ severity }) => severity === "warning");
  const ready = result.ready && open.length === 0 && lines !== 0;
  return <div aria-label="check result" className="readiness" role="region">
    <p className="state" data-state={ready ? "verified" : "refuted"}>{ready ? "Ready to start." : result.estimateError !== null ? "Not ready: the project could not be read (above)."
      : lines === 0 ? "Not ready: everything is left out." : !result.valid ? `Not ready: ${counted(errors.length, "problem")} in the lineup.` : errors.length > 0 ? `Not ready: ${counted(errors.length, "problem")} on this computer.` : `Not ready: ${counted(open.length, "value")} still to fill in.`}
      {result.modelBacked === false ? " It calls no model: scripted detectors." : ""}</p>
    {errors.length + warnings.length === 0 ? null : <ul aria-label="problems" className="plain-list diagnostics">{[...errors, ...warnings].map((item, index) => <Diagnostic item={item} key={`${item.code}-${item.path}-${index}`} />)}</ul>}
  </div>;
}

function Diagnostic({ item }: { readonly item: PreflightDiagnostic }): ReactElement {
  return <li className="state" data-state={item.severity === "error" ? "refuted" : "degraded"}>
    <p className="diagnostic__words">{item.severity === "warning" ? "Note: " : ""}{item.message}</p>
    <details><summary>recorded code</summary><code>{item.code}</code> · {item.scope === "environment" ? "this computer" : <code>{item.path}</code>}</details>
  </li>;
}

/** Another lineup: a saved one, the settings of a run, or a template for another way to run. */
function LineupChoice({ startKey, graph, loaded, configurations, onChoose }: { readonly startKey: string; readonly graph: string | null; readonly loaded: Loaded | null; readonly configurations: readonly { readonly id: string; readonly name: string }[]; readonly onChoose: (key: string) => void }): ReactElement {
  const cards = CARD_LINEUPS.has(startKey);
  const template = TEMPLATES.find(({ id }) => startKey === `template:${id}`);
  return <div className="lineup-choice">
    <label className="field">lineup
      <select aria-label="lineup" value={cards ? "template:subscription-audit" : startKey} onChange={(event) => onChoose(event.target.value)}>
        {startKey === "graph" ? <option value="graph">the saved graph {graph}</option> : null}
        {startKey.startsWith("run:") ? <option value={startKey}>the settings of run {startKey.slice(4)}</option> : null}
        <option value="template:subscription-audit">Claude Code and Codex, at the depth chosen above</option>
        {configurations.length === 0 ? null : <optgroup label="saved lineups">{configurations.map(({ id, name }) => <option key={id} value={`config:${id}`}>{name}</option>)}</optgroup>}
        <optgroup label="other lineups">{TEMPLATES.filter(({ id }) => !CARD_LINEUPS.has(`template:${id}`)).map(({ id, label }) => <option key={id} value={`template:${id}`}>{label}</option>)}</optgroup>
      </select>
    </label>
    {cards ? null : <p className="field__hint">{template?.description ?? (loaded === null ? "Loading the lineup." : startKey.startsWith("config:") ? `The saved lineup “${loaded.name}”.` : `Starting from ${loaded.source}.`)}</p>}
  </div>;
}

/** Load a lineup named by the address: a template, a saved lineup, a past run or a saved graph. */
async function startingPoint(from: string | null, graph: string | null, apis: ReturnType<typeof useApis>): Promise<Loaded> {
  if (from?.startsWith("config:") === true) {
    const stored = await apis.configurations.load<Draft>(from.slice("config:".length));
    return { draft: stored.config, name: stored.name, savedId: stored.id, source: `saved lineup ${stored.name}` };
  }
  if (from?.startsWith("run:") === true) {
    const runId = from.slice("run:".length);
    const overview = await apis.runs.overview(runId);
    // A scripted Audit stores no configuration; its preset, scope and review settings are enough to repeat it.
    const draft = overview.configuration ?? { ...SCRIPTED_AUDIT, scope: overview.scope, consensusPolicy: overview.consensusPolicy, maxConsensusRounds: overview.maximumRounds,
      workflow: overview.workflowGraph === null ? { preset: overview.workflowId ?? "audit-three-finders" } : { graph: overview.workflowGraph, ...(overview.checkpointMode === null ? {} : { checkpoints: { mode: overview.checkpointMode } }) } };
    // A rerun reads the project its run read.
    return { draft, name: `rerun of ${runId.slice(0, 12)}`, savedId: null, source: `the settings run ${runId} was created with`, ...(overview.repository === null ? {} : { repository: overview.repository }) };
  }
  if (from === null && graph !== null) {
    const [id, version] = graph.split("@");
    if (id === undefined || version === undefined || id === "" || version === "") throw new Error(`GRAPH_REFERENCE_INVALID:${graph}`);
    const draft = withGraph(setIn(SCRIPTED_AUDIT, ["workflow", "checkpoints"], { mode: "interactive" }), { id, version });
    return { draft, name: suggestedName("graph", draft), savedId: null, source: `the saved graph ${id} @ ${version}` };
  }
  const template = TEMPLATES.find(({ id }) => `template:${id}` === (from ?? DEFAULT_START)) ?? TEMPLATES[0];
  if (template === undefined) throw new Error("NO_TEMPLATES");
  return { draft: template.config, name: suggestedName(template.id, template.config), savedId: null, source: template.label };
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
