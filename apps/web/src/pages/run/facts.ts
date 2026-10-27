import type { RunOverview, RunProgress } from "../../api/runs.js";
import { isActive } from "../../app/format.js";
import type { WorkflowJson } from "../../graph/layout.js";
import { counted, duration, partsReadWords, stepShort, type Mode } from "../../app/words.js";
import { modelNodeLabels } from "./models.js";
import { stageElapsed } from "./StageGraph.js";

/** What the critic's record says, as recorded: its summary and items, and the revision's note when the plan was revised. */
export interface CritiqueRecord { readonly summary: string; readonly items: readonly { readonly blocking: boolean }[]; readonly revision?: { readonly notRevisedCritiqueItemIds?: readonly string[] } }
/** The preflight's record of what the run read. */
export interface PreflightRecord { readonly fileCount?: number; readonly lineCount?: number }

/** Each model step's model and effort in the model's own word, such as "Opus 5.5 · xhigh". */
export function stepModels(overview: RunOverview | null): ReadonlyMap<string, string> {
  return modelNodeLabels(overview?.configuration ?? null);
}

/** One more line under a stage's box: what the project read was, what each finder has read, how the review went. */
export function stageNotes({ workflow, progress, preflight, critique }: { readonly workflow: WorkflowJson; readonly progress: RunProgress | null; readonly preflight: PreflightRecord | null; readonly critique: CritiqueRecord | null }): ReadonlyMap<string, string> {
  const notes = new Map<string, string>();
  for (const node of workflow.nodes) {
    if (node.kind === "deterministic" && node.id === "preflight" && typeof preflight?.fileCount === "number") notes.set(node.id, counted(preflight.fileCount, "file"));
    const auditor = progress?.auditors.find(({ auditorId }) => auditorId === node.id);
    // Once a finder finished, its record of the units it sent says how many of them answered.
    if (auditor !== undefined && (auditor.partsRead > 0 || auditor.finished)) notes.set(node.id, auditor.coverage !== null ? partsReadWords(auditor.coverage, true)
      : `${counted(auditor.partsRead, "part")} read${auditor.partsDeclined === 0 ? "" : `, ${auditor.partsDeclined} declined`}`);
    if (node.id === "critic" && critique !== null) notes.set(node.id, criticWords(critique));
  }
  return notes;
}

/** How the plan review went, in words: it ran and objected, or it was not needed, or no model could do it. */
export function criticWords(critique: CritiqueRecord): string {
  const status = /^critic (not_required|skipped|disabled)/u.exec(critique.summary)?.[1];
  if (status === "not_required") return "not needed for this run";
  if (status === "skipped") return "skipped: no other model was free to review it";
  if (status === "disabled") return "not in this run";
  if (critique.items.length === 0) return "no objections";
  const unanswered = critique.revision?.notRevisedCritiqueItemIds?.length;
  return `${counted(critique.items.length, "objection")}${unanswered === undefined ? "" : ` · ${critique.items.length - unanswered} answered by the revised plan`}`;
}

/** The critic's record of whether it ran (`critic-result`): reviewed, not required, or skipped for want of an independent model. */
export interface CriticResultRecord { readonly status: "completed" | "not_required" | "skipped" }
export interface PlanReview { readonly reviewed: boolean; readonly words: string }

/**
 * Whether the plan was reviewed, from the run's records: the run's graph has a critic only when Review the plan was
 * switched on (off by default since October 25, 2026); `critic-result` says whether it then reviewed the plan, found no
 * review required (runs from before the switch) or was skipped; `critic-feedback` says what it found, and is the only
 * record of a scripted run's review.
 */
export function planReview({ workflow, result, feedback, state }: { readonly workflow: WorkflowJson; readonly result: CriticResultRecord | null; readonly feedback: CritiqueRecord | null; readonly state: string | null }): PlanReview {
  if (!workflow.nodes.some(({ id }) => id === "critic")) return { reviewed: false, words: "no: Review the plan was off for this run" };
  if (result?.status === "not_required") return { reviewed: false, words: "no: not needed for this run" };
  if (result?.status === "skipped") return { reviewed: false, words: "no: no other model was free to review it" };
  if (result?.status === "completed") return { reviewed: true, words: feedback === null ? "reviewed" : criticWords(feedback) };
  if (feedback !== null) {
    const words = criticWords(feedback);
    return /^critic (not_required|skipped|disabled)/u.test(feedback.summary) ? { reviewed: false, words: `no: ${words.replace(/^skipped: /u, "")}` } : { reviewed: true, words };
  }
  return { reviewed: false, words: state === "COMPLETED" ? "recorded no review" : isActive(state) ? "not yet" : "not yet: the run stopped before it" };
}

/** The run's working time so far: from its records when they carry times, else from its start to its last record. */
export function runTime(progress: RunProgress | null, overview: RunOverview | null, now: number): { readonly ms: number; readonly recorded: boolean } | null {
  const recorded = progress === null ? null : stageElapsed(progress.run, now);
  if (recorded !== null) return { ms: recorded, recorded: true };
  const started = Date.parse(overview?.createdAt ?? "");
  const ended = progress?.live === true ? now : Date.parse(overview?.updatedAt ?? "");
  return Number.isNaN(started) || Number.isNaN(ended) ? null : { ms: Math.max(0, ended - started), recorded: false };
}

/**
 * How long each step took, as recorded: "finding 53 min, checking 19 min, plan 26 min". Steps that ran side by side
 * (the finders) count once, as the longest of them; steps under a minute are left out. Null when no step's time is
 * recorded or every step took under a minute.
 */
export function stageTimes(workflow: WorkflowJson, mode: Mode, progress: RunProgress | null, now: number): string | null {
  if (progress === null) return null;
  const steps = new Map<string, number>();
  for (const node of workflow.nodes) {
    const stage = progress.stages.find(({ nodeId }) => nodeId === node.id);
    const elapsed = stage === undefined || stage.status === "waiting" || stage.status === "reused" ? null : stageElapsed(stage, now);
    // A step of seconds (reading the project, most of all) says nothing beside steps of minutes.
    if (elapsed === null || elapsed < 60_000) continue;
    const name = stepShort(node, mode);
    steps.set(name, Math.max(steps.get(name) ?? 0, elapsed));
  }
  return steps.size === 0 ? null : [...steps].map(([name, ms]) => `${name} ${duration(ms)}`).join(", ");
}
