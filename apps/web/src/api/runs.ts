import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "./sse.js";
import type { WorkflowJson } from "../graph/layout.js";

/** A generic human checkpoint; answer its current `version`, then resume the run. */
export interface HumanCheckpointResource { readonly kind: "human"; readonly checkpointId: string; readonly version: string; readonly mode: "interactive" | "automatic"; readonly status: "pending" | "approved" | "rejected"; readonly prompt: string; readonly decisions: readonly ("approve" | "reject")[]; readonly nodeId?: string }
export interface RequirementsCheckpointResource { readonly kind: "requirements"; readonly artifactId: string; readonly pendingAmbiguityIds: readonly string[]; readonly revisionProposalArtifactId?: string }
/** An interactive Audit's blocking plan questions; answer every one for the current `version`, then resume. */
export interface PlanQuestionsCheckpointResource { readonly kind: "plan-questions"; readonly checkpointId: "plan-questions"; readonly version: string; readonly status: "pending" | "answered"; readonly questions: readonly { readonly id: string; readonly question: string; readonly blastRadius: string }[] }
export type CheckpointResource = HumanCheckpointResource | RequirementsCheckpointResource | PlanQuestionsCheckpointResource;
export interface RunResource { readonly runId: string; readonly state: string; readonly resumable: boolean; readonly checkpoints: readonly CheckpointResource[]; readonly eventsCursor?: string; readonly preservedArtifacts?: number; readonly workflow?: WorkflowJson; /** Present when the run executes a saved operator-authored graph. */ readonly workflowGraph?: { readonly id: string; readonly version: string; readonly executedVersion: string } }
export interface EstimateResource { readonly estimate: { readonly files: number; readonly lines: number; readonly nodes: number; readonly auditors: number; readonly providerCalls: number | null; readonly costUsd: number | null; readonly currency: string | null; readonly basis: string }; readonly gate: string }

/** One run in the run list, as the orchestrator read it from the run's own records. */
export interface RunListItem {
  readonly runId: string;
  /** Null only when the run's records cannot be read; `problem` then says why. */
  readonly state: string | null;
  readonly reason: string | null;
  readonly mode: "audit" | "feature" | "testing" | null;
  readonly workflowId: string | null;
  readonly repository: string | null;
  readonly executor: "models" | "scripted" | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** Whether this control plane is executing the run; false for a run executed elsewhere or interrupted. */
  readonly live: boolean;
  readonly replayOf: string | null;
  readonly pendingDecisions: number;
  readonly gate: { readonly status: "passed" | "failed"; readonly reasons: readonly string[] } | null;
  readonly problem: string | null;
}
/** A run's list entry plus the settings it was created with. */
export interface RunOverview extends RunListItem {
  readonly scope: { readonly kind: string; readonly [key: string]: unknown };
  readonly consensusPolicy: string;
  readonly maximumRounds: number;
  readonly criticEnabled: boolean;
  readonly checkpointMode: "interactive" | "automatic" | null;
  readonly workflowGraph: { readonly id: string; readonly version: string } | null;
  /** The configuration a model-backed run executes; a scripted Audit stores none. */
  readonly configuration: Readonly<Record<string, unknown>> | null;
}
export interface PreflightDiagnostic { readonly code: string; readonly severity: "error" | "warning"; readonly scope: "configuration" | "environment"; readonly path: string; readonly message: string }
/** The orchestrator's preflight of an unsaved configuration, with the estimate when it is valid. */
export interface PreflightResult {
  readonly valid: boolean;
  readonly ready: boolean;
  readonly mode: string | null;
  readonly preset: string | null;
  readonly modelBacked: boolean | null;
  readonly diagnostics: readonly PreflightDiagnostic[];
  readonly repository: string;
  readonly estimate: EstimateResource | null;
  readonly estimateError: string | null;
}

export class RunApi {
  constructor(private readonly baseUrl = "") {}
  list(): Promise<readonly RunListItem[]> { return this.request("/runs"); }
  overview(runId: string): Promise<RunOverview> { return this.request(`/runs/${encodeURIComponent(runId)}/overview`); }
  selectedRepository(): Promise<{ readonly repository: string }> { return this.request("/repositories/selected"); }
  selectRepository(path: string): Promise<unknown> { return this.request("/repositories/select", { method: "POST", body: JSON.stringify({ path }) }); }
  preflight(config: unknown, repository = ""): Promise<PreflightResult> { return this.request("/preflight", { method: "POST", body: JSON.stringify(repository.trim() === "" ? { config } : { config, repository }) }); }
  estimate(configurationId: string, repository = ""): Promise<EstimateResource> { return this.request("/estimate", { method: "POST", body: JSON.stringify(runBody(configurationId, repository)) }); }
  start(configurationId: string, repository = ""): Promise<RunResource> { return this.request("/runs", { method: "POST", body: JSON.stringify(runBody(configurationId, repository)) }); }
  status(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}`); }
  resume(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" }); }
  cancel(runId: string): Promise<RunResource> { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }); }
  respondCheckpoint(runId: string, checkpointId: string, version: string, decision: "approve" | "reject"): Promise<{ readonly accepted: true }> { return this.request(`/runs/${encodeURIComponent(runId)}/checkpoints/${encodeURIComponent(checkpointId)}`, { method: "POST", body: JSON.stringify({ version, decision }) }); }
  answerPlanQuestions(runId: string, version: string, answers: readonly { readonly questionId: string; readonly answer: string }[]): Promise<{ readonly accepted: true }> { return this.request(`/runs/${encodeURIComponent(runId)}/checkpoints/plan-questions`, { method: "POST", body: JSON.stringify({ version, answers }) }); }
  eventsUrl(runId: string): string { return `${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`; }
  // Bodiless POSTs (resume, cancel) must not declare a JSON body: the server rejects an empty
  // `application/json` body with 400, which the browser QA found silently broke both controls.
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers } });
    if (!response.ok) throw new Error(await failureText(response, `RUN_API_${response.status}`));
    return await response.json() as T;
  }
}

/** The server's own explanation when it gave one, with the status for reference. */
export async function failureText(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown };
    return typeof body.message === "string" && body.message !== "" ? `${body.message} (${fallback})` : fallback;
  } catch { return fallback; }
}

export interface RehydratedRun {
  readonly resource: RunResource | null;
  readonly events: readonly RunEvent[];
  /** The reason recorded with the latest state transition, such as why the run failed. */
  readonly reason: string | null;
  readonly error: string | null;
}

export function useRehydratedRun(api: RunApi, runId: string | null, refreshKey: unknown = null): RehydratedRun {
  const [resource, setResource] = useState<RunResource | null>(null);
  const [events, setEvents] = useState<readonly RunEvent[]>([]);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const subscribed = useRef<string | null>(null);
  useEffect(() => {
    // Re-subscribing to the same run (after a decision, a cancel or a resume) keeps its last
    // known state on screen until the new read answers, so the page does not blank and lose
    // what the operator was looking at. The event stream replays from the start, so the
    // event list starts over either way.
    const same = subscribed.current === runId;
    subscribed.current = runId;
    if (!same) { setResource(null); setReason(null); }
    setEvents([]); setError(null);
    if (runId === null) return;
    let active = true;
    let source: EventSource | null = null;
    let ended = false;
    void api.status(runId).then((initial) => {
      if (!active) return;
      setResource(initial);
      try { source = new EventSource(api.eventsUrl(runId)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
      source.onmessage = ({ data }) => {
        if (!active) return;
        try {
          const event: unknown = JSON.parse(data as string);
          if (!isRunEvent(event) || event.runId !== runId) throw new Error("INVALID_RUN_EVENT");
          setError(null);
          setEvents((current) => Object.freeze([...current, event]));
          if (event.t === "run_transition" && event.state !== undefined) {
            const state = event.state;
            setReason(event.reason ?? null);
            setResource((current) => current === null ? current : { ...current, state, resumable: state !== "COMPLETED" });
            // A run that stops (blocked on a checkpoint, finished, failed) has new durable
            // state the event does not carry: its checkpoints and its executed graph.
            if (state !== "CREATED" && state !== "RUNNING") void api.status(runId).then((latest) => { if (active) setResource(latest); }, () => undefined);
          }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); source?.close(); }
      };
      source.addEventListener?.("end", () => { ended = true; source?.close(); });
      source.onerror = () => { if (active && !ended) { setError("RUN_EVENT_STREAM_UNAVAILABLE"); source?.close(); } };
    }, (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; source?.close(); };
  }, [api, runId, refreshKey]);
  return { resource, events, reason, error };
}

export interface Loaded<T> { readonly value: T | null; readonly error: string | null; readonly loading: boolean }

/**
 * Loads the value named by `key`, again whenever `refreshKey` changes. A reload of the same
 * key keeps showing the previous value until the new one arrives, and keeps it (with the
 * error) when the reload fails; a new key starts empty, and a null key loads nothing.
 */
export function useLoaded<T>(key: string | null, load: () => Promise<T>, refreshKey: unknown = null): Loaded<T> {
  const loader = useRef(load);
  loader.current = load;
  const [state, setState] = useState<Loaded<T> & { readonly key: string | null }>({ key: null, value: null, error: null, loading: false });
  useEffect(() => {
    if (key === null) { setState({ key, value: null, error: null, loading: false }); return; }
    let active = true;
    setState((current) => ({ key, value: current.key === key ? current.value : null, error: null, loading: true }));
    void loader.current().then(
      (value) => { if (active) setState({ key, value, error: null, loading: false }); },
      (cause: unknown) => { if (active) setState((current) => ({ key, value: current.key === key ? current.value : null, error: cause instanceof Error ? cause.message : String(cause), loading: false })); });
    return () => { active = false; };
  }, [key, refreshKey]);
  return state.key === key ? state : { value: null, error: null, loading: key !== null };
}

function runBody(configurationId: string, repository: string): { configurationId: string; repository?: string } {
  return repository.trim() === "" ? { configurationId } : { configurationId, repository };
}
function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event["t"] !== "string" || typeof event["runId"] !== "string") return false;
  if (event["t"] === "run_transition" && typeof event["state"] !== "string") return false;
  return true;
}
