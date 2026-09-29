import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { RunApi, type HumanCheckpointResource, type PlanQuestionsCheckpointResource, type RunResource } from "../api/runs.js";
export function RunControls({ api, configurationId, initialRunId = null, initialRepository = "", currentRun, onRunStarted }: { readonly api: RunApi; /** Null when no configuration is saved: an opened run can still be inspected, resumed and cancelled. */ readonly configurationId: string | null; readonly initialRunId?: string | null; readonly initialRepository?: string; readonly currentRun?: RunResource | null; readonly onRunStarted?: (run: RunResource) => void }): ReactElement {
  const [repository, setRepository] = useState(initialRepository);
  const [run, setRun] = useState<RunResource | null>(null);
  const [estimate, setEstimate] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const invoke = useCallback(async (operation: () => Promise<RunResource>, started = false): Promise<void> => {
    try { const result = await operation(); setRun(result); setError(null); if (started) onRunStarted?.(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [onRunStarted]);
  useEffect(() => { setRepository(initialRepository); }, [initialRepository]);
  useEffect(() => {
    setRun(null); setError(null);
    if (initialRunId === null) return;
    let active = true;
    void api.status(initialRunId).then((value) => { if (active) setRun(value); }, (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [api, initialRunId]);
  useEffect(() => { if (currentRun !== undefined && currentRun !== null) setRun(currentRun); }, [currentRun]);
  const checkpoint = run?.checkpoints.find((item): item is HumanCheckpointResource => item.kind === "human" && item.status === "pending");
  const questions = run?.checkpoints.find((item): item is PlanQuestionsCheckpointResource => item.kind === "plan-questions" && item.status === "pending");
  const activeRunId = run?.runId ?? null;
  const respond = async (runId: string, target: HumanCheckpointResource, decision: "approve" | "reject"): Promise<void> => {
    try {
      await api.respondCheckpoint(runId, target.checkpointId, target.version, decision);
      await invoke(() => api.status(runId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <section aria-labelledby="run-controls-title">
    <h2 className="panel-title" id="run-controls-title">run controls</h2>
    <label>repository<input value={repository} onChange={(event) => setRepository(event.target.value)} /></label>
    <div className="run-actions">
      <button type="button" onClick={async () => { try { await api.selectRepository(repository); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>select</button>
      <button type="button" disabled={configurationId === null} onClick={async () => { if (configurationId === null) return; try { setEstimate(await api.estimate(configurationId, repository)); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>estimate</button>
      <button type="button" disabled={configurationId === null} onClick={() => { if (configurationId !== null) void invoke(() => api.start(configurationId, repository), true); }}>start</button>
      {run === null ? null : <>
        <button type="button" onClick={() => { void invoke(() => api.status(run.runId)); }}>status</button>
        <button type="button" disabled={!run.resumable} onClick={() => { void invoke(() => api.resume(run.runId), true); }}>resume</button>
        <button type="button" onClick={() => { void invoke(() => api.cancel(run.runId)); }}>cancel</button>
      </>}
    </div>
    {configurationId === null ? <p className="state" data-state="unexamined">estimate and start unavailable · no saved configuration</p> : null}
    {estimate === null ? null : <pre aria-label="run estimate">{JSON.stringify(estimate, null, 2)}</pre>}
    {run === null ? <p className="state" data-state="unexamined">run unavailable</p> : <p>run {run.runId} · {run.state} · {run.resumable ? "resumable" : "not resumable"}</p>}
    {checkpoint === undefined || activeRunId === null ? null : <div className="checkpoint" role="alert">
      <p>{checkpoint.checkpointId} · {checkpoint.prompt}</p>
      <button type="button" onClick={() => { void respond(activeRunId, checkpoint, "approve"); }}>approve</button>
      <button type="button" onClick={() => { void respond(activeRunId, checkpoint, "reject"); }}>reject</button>
    </div>}
    {questions === undefined || activeRunId === null ? null : <PlanQuestionsForm key={questions.version} checkpoint={questions} onSubmit={async (answers) => {
      try { await api.answerPlanQuestions(activeRunId, questions.version, answers); await invoke(() => api.status(activeRunId)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }} />}
    {error === null ? null : <p className="state" data-state="degraded" role="alert">{error}</p>}
  </section>;
}
/** Every blocking question needs an answer; answers are sent once, for this exact plan version. */
function PlanQuestionsForm({ checkpoint, onSubmit }: { readonly checkpoint: PlanQuestionsCheckpointResource; readonly onSubmit: (answers: readonly { readonly questionId: string; readonly answer: string }[]) => Promise<void> }): ReactElement {
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const complete = checkpoint.questions.every(({ id }) => (answers[id] ?? "").trim() !== "");
  return <form aria-label="plan questions" className="checkpoint" onSubmit={(event) => { event.preventDefault(); if (complete) void onSubmit(checkpoint.questions.map(({ id }) => ({ questionId: id, answer: answers[id] ?? "" }))); }}>
    <p>plan questions · answer each, then resume</p>
    {checkpoint.questions.map(({ id, question, blastRadius }) => <label key={id}>{id} · {question} · {blastRadius} impact
      <textarea value={answers[id] ?? ""} onChange={(event) => { const value = event.target.value; setAnswers((current) => ({ ...current, [id]: value })); }} />
    </label>)}
    <button type="submit" disabled={!complete}>answer</button>
  </form>;
}
export function InspectorOverlay({ open, title, onDismiss, children }: { readonly open: boolean; readonly title: string; readonly onDismiss: () => void; readonly children: ReactElement }): ReactElement | null { const close = useRef<HTMLButtonElement>(null); useEffect(() => { if (!open) return; close.current?.focus(); const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onDismiss(); }; document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey); }, [open, onDismiss]); if (!open) return null; return <aside aria-label={title} aria-modal="true" className="inspector-overlay" role="dialog"><button ref={close} type="button" onClick={onDismiss}>close inspector</button>{children}</aside>; }
