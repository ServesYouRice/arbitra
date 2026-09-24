import "../operator.css";
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { ArtifactApi, type ArtifactDescriptor } from "../../api/artifacts.js";
import { downloadJson, failure, OperatorApiError, RequirementsApi, type RequirementsDraft, type RequirementsResource } from "../../api/operator.js";
import { RunApi, type RunResource } from "../../api/runs.js";

export interface FeatureViewProps {
  readonly runId: string | null;
  readonly run: RunResource | null;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly api?: RequirementsApi;
  readonly runApi?: RunApi;
  readonly artifactApi?: ArtifactApi;
  readonly refreshKey?: unknown;
  /** Called with the resumed run so the workspace resubscribes to its event stream. */
  readonly onResumed?: (run: RunResource) => void;
}

/**
 * Feature contract inspection and operator decisions over the existing requirements API.
 *
 * Every mutation names the contract artifact it was made against; a stale artifact is
 * refused by the server with 409 and shown here as stale, with an explicit reload. Approval
 * and revision never resume the run; resume is its own explicit action. Model-authored
 * contract text is untrusted and rendered only as text.
 */
export function FeatureView({ runId, run, artifacts, api = SHARED_REQUIREMENTS, runApi = SHARED_RUNS, artifactApi = SHARED_ARTIFACTS, refreshKey = null, onResumed }: FeatureViewProps): ReactElement {
  const feature = run?.workflow?.id === "feature-simple";
  const [reload, setReload] = useState(0);
  const [resource, setResource] = useState<RequirementsResource | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<OperatorApiError | Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setResource(undefined); setLoadError(null);
    if (runId === null || !feature) return;
    let active = true;
    void api.current(runId).then((value) => { if (active) setResource(value); }, (cause: unknown) => { if (active) setLoadError(failure(cause)); });
    return () => { active = false; };
  }, [api, runId, feature, refreshKey, reload]);
  useEffect(() => { setSelected([]); setEditing(false); }, [resource?.artifactId]);

  if (runId === null || run === null) return <Frame><p className="state" data-state="unexamined">select a Feature run to inspect its requirements contract</p></Frame>;
  if (!feature) return <Frame><p className="state" data-state="unexamined">not a Feature run · workflow {run.workflow?.id ?? "unavailable"}</p></Frame>;
  if (loadError !== null) return <Frame><p className="state" data-state="degraded" role="alert">requirements contract unavailable · {loadError}</p><button type="button" onClick={() => setReload((value) => value + 1)}>reload contract</button></Frame>;
  if (resource === undefined) return <Frame><p role="status">loading requirements contract</p></Frame>;

  const blocked = run.state === "BLOCKED";
  const act = async (label: string, operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setActionError(null); setNotice(null);
    try { await operation(); setNotice(label); setReload((value) => value + 1); }
    catch (cause) { setActionError(cause instanceof Error ? cause : new Error(String(cause))); }
    finally { setBusy(false); }
  };
  const resume = async (): Promise<void> => {
    setBusy(true); setActionError(null); setNotice(null);
    try { const resumed = await runApi.resume(runId); setNotice("resume requested"); onResumed?.(resumed); }
    catch (cause) { setActionError(cause instanceof Error ? cause : new Error(String(cause))); }
    finally { setBusy(false); }
  };
  const handoff = artifacts.find(({ kind }) => kind === "implementation");
  const outcome = artifacts.find(({ kind }) => kind === "feature-outcome");

  return <Frame>
    <RunLine run={run} />
    {resource === null ? <p className="state" data-state="unexamined">no requirements contract recorded for this run yet</p> : <Contract resource={resource} selected={selected} onToggle={(id) => setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])} />}
    {resource === null ? null : <section aria-labelledby="feature-decisions-title" className="operator-section">
      <h3 className="panel-title" id="feature-decisions-title">operator decisions</h3>
      {blocked ? null : <p className="state" data-state="unexamined">decisions require a blocked run · state {run.state}</p>}
      <div className="operator-actions">
        <button type="button" disabled={!blocked || busy || selected.length === 0} onClick={() => { void act(`approved ${selected.join(", ")}`, () => api.approve(runId, resource.artifactId, selected)); }}>approve selected defaults</button>
        <button type="button" aria-expanded={editing} disabled={!blocked || busy} onClick={() => { setEditing((value) => !value); setDraftText(JSON.stringify(draftOf(resource), null, 2)); }}>{editing ? "close draft revision" : "revise draft"}</button>
        <button type="button" disabled={busy || !run.resumable || run.state === "RUNNING"} onClick={() => { void resume(); }}>resume run</button>
      </div>
      <p className="operator-note">Approval and revision are recorded against contract {resource.artifactId}. Neither resumes the run; resume is explicit. A revision clears earlier approvals.</p>
      {!editing ? null : <form className="operator-form" onSubmit={(event) => {
        event.preventDefault();
        let draft: unknown;
        try { draft = JSON.parse(draftText); } catch { setActionError(new Error("DRAFT_NOT_JSON")); return; }
        void act("revision recorded · earlier approvals cleared", () => api.revise(runId, resource.artifactId, draft));
      }}>
        <label>draft JSON · assumptions, ambiguities, acceptance, out of scope<textarea aria-label="draft JSON" rows={12} spellCheck={false} value={draftText} onChange={(event) => setDraftText(event.target.value)} /></label>
        <button type="submit" disabled={busy}>submit revision</button>
      </form>}
      {resource.revisionProposal === undefined ? null : <Proposal resource={resource} disabled={!blocked || busy} onApply={() => { void act("proposal applied · approve the new defaults before resuming", () => api.applyRevision(runId, resource.revisionProposal?.artifactId ?? "")); }} />}
    </section>}
    {notice === null ? null : <p className="state" data-state="verified" role="status">{notice}</p>}
    {actionError === null ? null : <div className="state" data-state={actionError instanceof OperatorApiError && actionError.stale ? "refuted" : "degraded"} role="alert">
      <p>{actionError instanceof OperatorApiError && actionError.stale ? `stale · refused by the server · ${actionError.code}` : `request failed · ${actionError.message}`}</p>
      <button type="button" onClick={() => { setActionError(null); setReload((value) => value + 1); }}>reload contract</button>
    </div>}
    <section aria-labelledby="feature-handoff-title" className="operator-section">
      <h3 className="panel-title" id="feature-handoff-title">outcome and handoff</h3>
      {outcome === undefined ? <p className="state" data-state="unexamined">no Feature outcome recorded</p> : <FeatureOutcome api={artifactApi} runId={runId} artifactId={outcome.artifactId} />}
      {handoff === undefined ? <p className="state" data-state="unexamined">no implementation handoff · withheld until the plan passes its gate</p>
        : <button type="button" onClick={() => { void artifactApi.load(runId, handoff.artifactId).then((artifact) => downloadJson(`${runId}-implementation.json`, JSON.parse(artifact.content) as unknown), (cause: unknown) => setActionError(cause instanceof Error ? cause : new Error(String(cause)))); }}>download implementation handoff</button>}
    </section>
  </Frame>;
}

function Frame({ children }: { readonly children: ReactNode }): ReactElement {
  return <section aria-label="feature contract" className="operator-view"><h2 className="panel-title">feature contract</h2>{children}</section>;
}
function RunLine({ run }: { readonly run: RunResource }): ReactElement {
  return <p className="operator-run">run {run.runId} · {run.state} · {run.resumable ? "resumable" : "not resumable"}</p>;
}

function Contract({ resource, selected, onToggle }: { readonly resource: RequirementsResource; readonly selected: readonly string[]; readonly onToggle: (id: string) => void }): ReactElement {
  const { contract, pendingAmbiguityIds } = resource;
  const accepted = new Map(contract.decision.acceptedDefaults.map((decision) => [decision.ambiguityId, decision]));
  return <section aria-labelledby="feature-contract-title" className="operator-section">
    <h3 className="panel-title" id="feature-contract-title">requirements contract</h3>
    <dl className="operator-facts">
      <div><dt>contract artifact</dt><dd>{resource.artifactId}</dd></div>
      <div><dt>decision mode</dt><dd>{contract.decision.mode}</dd></div>
      <div><dt>pending approvals</dt><dd className="state" data-state={pendingAmbiguityIds.length === 0 ? "verified" : "unexamined"}>{pendingAmbiguityIds.length === 0 ? "none" : pendingAmbiguityIds.join(", ")}</dd></div>
    </dl>
    <p className="state" data-state="tainted">feature request · {contract.featureRequest}</p>
    <h4 className="panel-title">assumptions · model-authored</h4>
    <ul className="operator-list">{contract.assumptions.map(({ id, statement, confidence }) => <li className="state" data-state="tainted" key={id}>{id} · confidence {confidence} · {statement}</li>)}</ul>
    <h4 className="panel-title">ambiguities and proposed defaults</h4>
    {contract.ambiguities.length === 0 ? <p className="state" data-state="unexamined">no ambiguities recorded</p> : <ul className="operator-list">{contract.ambiguities.map(({ id, question, proposedDefault, blastRadius }) => {
      const decision = accepted.get(id);
      const pending = pendingAmbiguityIds.includes(id);
      return <li className="operator-ambiguity" data-blast={blastRadius} key={id}>
        <p className="state" data-state="tainted">{id} · blast radius {blastRadius} · {question}</p>
        <p>proposed default · {proposedDefault}</p>
        <p className="state" data-state={pending ? "unexamined" : decision === undefined ? "unexamined" : "verified"}>{pending ? "approval pending" : decision === undefined ? "no operator approval required at this blast radius" : `accepted by ${decision.acceptedBy.replace("_", " ")}`}</p>
        {!pending ? null : <label className="operator-check"><input type="checkbox" checked={selected.includes(id)} onChange={() => onToggle(id)} />approve default for {id}</label>}
      </li>;
    })}</ul>}
    <h4 className="panel-title">acceptance</h4>
    <ul className="operator-list">{contract.acceptance.map(({ id, assertion }) => <li className="state" data-state="tainted" key={id}>{id} · {assertion}</li>)}</ul>
    <h4 className="panel-title">out of scope</h4>
    {contract.outOfScope.length === 0 ? <p className="state" data-state="unexamined">no exclusions recorded</p> : <ul className="operator-list">{contract.outOfScope.map((item) => <li key={item}>{item}</li>)}</ul>}
  </section>;
}

function Proposal({ resource, disabled, onApply }: { readonly resource: RequirementsResource; readonly disabled: boolean; readonly onApply: () => void }): ReactElement | null {
  const proposal = resource.revisionProposal;
  const changes = useMemo(() => proposal === undefined ? [] : proposalChanges(draftOf(resource), proposal.revision.draft), [resource, proposal]);
  if (proposal === undefined) return null;
  return <section aria-labelledby="feature-proposal-title" className="operator-proposal">
    <h4 className="panel-title" id="feature-proposal-title">model revision proposal · not applied</h4>
    <p className="state" data-state="dissent">independent review left requirements unresolved; {proposal.modelProfileId} proposed a revision of {proposal.baseArtifactId}</p>
    <ul className="operator-list" aria-label="proposed changes">{changes.length === 0 ? <li className="state" data-state="unexamined">no field changes</li> : changes.map(({ id, field, before, after }) => <li className="state" data-state="tainted" key={`${id}:${field}`}>{id} · {field} · {before} → {after}</li>)}</ul>
    <ul className="operator-list" aria-label="proposal resolutions">{proposal.revision.resolutions.map(({ requirementId, resolution }) => <li className="state" data-state="tainted" key={requirementId}>{requirementId} · {resolution}</li>)}</ul>
    <button type="button" disabled={disabled} onClick={onApply}>apply proposal</button>
    <p className="operator-note">Applying creates a new contract, clears earlier approvals and requires independent re-review after resume.</p>
  </section>;
}

function FeatureOutcome({ api, runId, artifactId }: { readonly api: ArtifactApi; readonly runId: string; readonly artifactId: string }): ReactElement {
  const [value, setValue] = useState<{ passed?: unknown; reasons?: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void api.load(runId, artifactId).then((artifact) => { if (active) setValue(JSON.parse(artifact.content) as { passed?: unknown; reasons?: unknown }); }, (cause: unknown) => { if (active) setError(failure(cause)); }); return () => { active = false; }; }, [api, runId, artifactId]);
  if (error !== null) return <p className="state" data-state="degraded">Feature outcome unavailable · {error}</p>;
  if (value === null) return <p role="status">loading Feature outcome</p>;
  const reasons = Array.isArray(value.reasons) ? value.reasons.map(String) : [];
  return <p className="state" data-state={value.passed === true ? "verified" : "refuted"}>plan gate · {value.passed === true ? "passed" : "failed"}{reasons.length === 0 ? "" : ` · ${reasons.join(", ")}`}</p>;
}

function draftOf({ contract }: RequirementsResource): RequirementsDraft {
  return { assumptions: contract.assumptions, ambiguities: contract.ambiguities, acceptance: contract.acceptance, outOfScope: contract.outOfScope };
}
function proposalChanges(before: RequirementsDraft, after: RequirementsDraft): readonly { id: string; field: string; before: string; after: string }[] {
  const changes: { id: string; field: string; before: string; after: string }[] = [];
  const compare = <T extends { id: string }>(left: readonly T[], right: readonly T[], fields: readonly (keyof T & string)[]) => {
    for (const next of right) {
      const previous = left.find(({ id }) => id === next.id);
      for (const field of fields) if (String(previous?.[field] ?? "absent") !== String(next[field])) changes.push({ id: next.id, field, before: String(previous?.[field] ?? "absent"), after: String(next[field]) });
    }
  };
  compare(before.assumptions, after.assumptions, ["statement", "confidence"]);
  compare(before.ambiguities, after.ambiguities, ["question", "proposedDefault", "blastRadius"]);
  compare(before.acceptance, after.acceptance, ["assertion"]);
  return changes;
}

const SHARED_REQUIREMENTS = new RequirementsApi();
const SHARED_RUNS = new RunApi();
const SHARED_ARTIFACTS = new ArtifactApi();
