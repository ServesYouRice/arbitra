import { useState, type ReactElement } from "react";
import { useLoaded, type PremiseSummary } from "../../api/runs.js";
import { useApis } from "../../app/apis.js";
import { formatTime } from "../../app/format.js";
import { Link } from "../../app/router.js";
import { counted } from "../../app/words.js";
import { CopyButton } from "../../controls/CopyButton.js";
import type { PersistedPlan } from "../../views/plan/traceability.js";

/**
 * The plan's hand-over, on the Summary and the Plan tab: saving it into the project is the place's one primary action;
 * once saved (also after a reload, read from the project), the folder, the next step, what the premise check did not
 * find in the code, and the request to copy. Saved, the save button is gone, so a second click cannot write a second folder.
 */
export function PlanCard({ runId, plan, questions, onPlanTab = false }: { readonly runId: string; readonly plan: PersistedPlan; readonly questions: number; readonly onPlanTab?: boolean }): ReactElement {
  const { runs } = useApis();
  const [version, setVersion] = useState(0);
  const saved = useLoaded(`saved-plans:${runId}`, () => runs.savedPlans(runId), version);
  const [saving, setSaving] = useState<{ readonly busy: boolean; readonly failure: string | null }>({ busy: false, failure: null });
  const latest = saved.value?.saved[0] ?? null;
  const save = (): void => {
    setSaving({ busy: true, failure: null });
    void runs.savePlan(runId).then(() => { setSaving({ busy: false, failure: null }); setVersion((value) => value + 1); },
      (cause: unknown) => setSaving({ busy: false, failure: cause instanceof Error ? cause.message : String(cause) }));
  };
  const request = latest === null ? "" : `Work through ${latest.relative}/README.md in this project, one task at a time, as its AGENTS.md says.${questions > 0 ? " Ask me its questions first." : ""}`;
  const read = onPlanTab ? null : <Link className="more-link" to={{ page: "run", runId, tab: "plan", item: null }}>{latest === null ? "Read it first" : "Read the plan"}</Link>;
  return <section aria-labelledby="plan-card-title" className="plan-card" data-saved={latest !== null}>
    <h2 className="plan-card__title" id="plan-card-title">The plan is ready · {counted(plan.tasks.length, "task")} for {counted(plan.acceptedIssueIds.length, "issue")}</h2>
    {latest === null ? <>
      <p className="prose">Save it into the project: a folder with one prompt per task, sorted by the model each needs, and a README your coding agent follows.</p>
      <div className="actions">
        <button className="button button--primary" disabled={saving.busy} type="button" onClick={save}>{saving.busy ? "Saving the plan" : "Save the plan into the project"}</button>
        {read}
      </div>
      {saving.failure === null ? <p className="note">{saved.loading && saved.value === null ? "Checking whether it was saved before." : "Not saved yet. Nothing in the project changes until you save."}</p>
        : <p className="state" data-state="degraded" role="alert">The plan was not saved: {saving.failure}. Nothing in the project changed.</p>}
    </> : <>
      <p className="plan-card__saved"><span>Saved in the project</span> <code>{latest.relative}</code></p>
      <p className="prose">Next: open the project in Claude Code or Codex and ask it to work through <code>{latest.relative}/README.md</code>.{questions > 0 ? ` Answer the ${counted(questions, "question")} it asks first: they are decisions only you can make.` : ""}</p>
      {latest.premises == null ? null : <p className="prose">{premiseWords(latest.premises)}</p>}
      <div className="actions">
        <CopyButton label="Copy that request" text={request} />
        {read}
      </div>
      <p className="note">Saved {formatTime(latest.savedAt)}.{(saved.value?.saved.length ?? 0) > 1 ? ` ${saved.value?.saved.length ?? 0} copies are in .arbitra/plans; this is the newest.` : ""}</p>
    </>}
  </section>;
}

/** What the premise check found when the plan was saved, in words. */
export function premiseWords({ named, notFound, prompts }: PremiseSummary): string {
  if (notFound === 0) return `All ${named.toLocaleString("en")} things the prompts name were found in the code.`;
  return `${notFound.toLocaleString("en")} of the ${named.toLocaleString("en")} things the prompts name ${notFound === 1 ? "was" : "were"} not found in the code, in ${counted(prompts, "prompt")}. ${prompts === 1 ? "That prompt lists" : "Each of those prompts lists"} them, and the agent finds the real code or reports the premise false.`;
}
