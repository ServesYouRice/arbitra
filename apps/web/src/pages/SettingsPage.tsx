import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { HelperModel, HelperSettings } from "../api/settings.js";
import { useApis } from "../app/apis.js";
import { runsThrough } from "./new-run/ChangeModels.js";
import { MODEL_CATALOG, offeredCatalog, type CatalogModel } from "./new-run/model-catalog.js";
import { offeredModels, type DetectedEnvironment } from "./new-run/ThisComputer.js";
import { modelName } from "./run/models.js";

/**
 * This computer's settings: what the run helper does (`helper.autoResume`, `helper.model` in `<state>/settings.json`),
 * read and saved through the server's settings route (apps/server/src/settings.ts). A change is saved as it is made,
 * and counts without a restart: the helper reads the file at each decision.
 */
export function SettingsPage(): ReactElement {
  const apis = useApis();
  const [helper, setHelper] = useState<HelperSettings | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly saved: true } | { readonly saved: false; readonly failure: string } | null>(null);
  const [environment, setEnvironment] = useState<DetectedEnvironment | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    apis.settings.load().then(({ helper: loaded }) => { if (alive.current) setHelper(loaded); }, (error: unknown) => { if (alive.current) setLoadFailure(message(error)); });
    // What Antigravity offers on this computer joins its list, as on New run; without it the lists are arbitra's own.
    fetch("/diagnostics/environment").then(async (response) => response.ok ? await response.json() as DetectedEnvironment : null)
      .then((found) => { if (alive.current) setEnvironment(found); }, () => undefined);
  }, [apis.settings]);
  const save = (change: Partial<HelperSettings>): void => {
    setSaving(true); setOutcome(null);
    apis.settings.save(change)
      .then(({ helper: saved }) => { if (alive.current) { setHelper(saved); setOutcome({ saved: true }); } }, (error: unknown) => { if (alive.current) setOutcome({ saved: false, failure: message(error) }); })
      .finally(() => { if (alive.current) setSaving(false); });
  };
  return <>
    <div className="page-head"><div className="page-head__text">
      <h1 className="page-title">Settings</h1>
      <p className="lead">How arbitra works on this computer. Saved in settings.json in its runs folder; a change counts at once, with no restart.</p>
    </div></div>
    {loadFailure === null ? null : <p className="state" data-state="degraded" role="alert">The settings could not be read · {loadFailure}</p>}
    {helper === null ? loadFailure === null ? <p className="state" data-state="unexamined" role="status">reading the settings</p> : null
      : <section aria-labelledby="helper-title" className="surface form-section">
        <h2 className="panel-title" id="helper-title">run helper</h2>
        <p className="prose">When a run stops on a usage limit, a time-out or a provider failure, the helper waits and resumes it: a minute after the limit resets, or a few minutes later. It resumes a run at most twice, never one you cancelled, and each thing it does shows on the run's page.</p>
        <label className="tick"><input checked={helper.autoResume} disabled={saving} type="checkbox" onChange={(event) => save({ autoResume: event.target.checked })} />
          <span>resume stopped runs<span className="field__hint">Off, every stop waits for you. A lineup can also turn it off for its own runs (<code>workflow.autoResume: false</code> in its configuration).</span></span></label>
        <HelperModelChoice model={helper.model} disabled={saving} environment={environment} onChoose={(model) => save({ model })} />
      </section>}
    {outcome === null ? null : outcome.saved ? <p className="state" data-state="verified" role="status">saved</p>
      : <p className="state" data-state="degraded" role="alert">Not saved · {outcome.failure}</p>}
  </>;
}

/**
 * The helper's model, chosen as Change models chooses a profile's: from the models known to work through each CLI or
 * API a lineup can use, with what Antigravity offers on this computer. A model the file names that no list has stays
 * as its own choice.
 */
function HelperModelChoice({ model, disabled, environment, onChoose }: { readonly model: HelperModel; readonly disabled: boolean; readonly environment: DetectedEnvironment | null; readonly onChoose: (model: HelperModel) => void }): ReactElement {
  const groups = useMemo(() => {
    const offered = offeredModels(environment);
    return Object.keys(MODEL_CATALOG).map((transport) => ({ transport, models: offeredCatalog(transport, offered) ?? [] }));
  }, [environment]);
  const listed = groups.some(({ transport, models }) => transport === model.transport && models.some(({ modelId }) => modelId === model.modelId));
  const choose = (value: string): void => {
    const split = value.indexOf("|");
    onChoose({ transport: value.slice(0, split), modelId: value.slice(split + 1) });
  };
  return <><label className="field">helper's model
    <select disabled={disabled} value={valueOf(model)} onChange={(event) => choose(event.target.value)}>
      {listed ? null : <option value={valueOf(model)}>{modelName(model.modelId)} through {runsThrough(model.transport)} (as settings.json names it)</option>}
      {groups.map(({ transport, models }) => <optgroup key={transport} label={`through ${runsThrough(transport)}`}>
        {models.map((choice, index) => <option key={choice.modelId} value={valueOf({ transport, modelId: choice.modelId })}>{optionText(choice, index)}</option>)}
      </optgroup>)}
    </select></label>
    <p className="field__hint">The model the helper asks where its rules cannot decide: a stop no rule names, and the Feature interview. Neither is built yet, so nothing calls it today. A frontier model is the default.</p>
  </>;
}

const valueOf = ({ transport, modelId }: HelperModel): string => `${transport}|${modelId}`;
const optionText = (model: CatalogModel, index: number): string => `${modelName(model.modelId)}${index === 0 ? " (recommended)" : ""}${model.note === "" ? "" : ` · ${model.note}`}`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
