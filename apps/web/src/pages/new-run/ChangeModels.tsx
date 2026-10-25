import { useState, type ReactElement } from "react";
import { modelName, modelProfiles, PLACEHOLDER_PREFIX, roleEffort, type ModelProfileSummary } from "../run/models.js";
import { getIn, roleSlots, type Draft, type Edit, type RoleSlot } from "./draft.js";
import { modelSettings, offeredCatalog, type CatalogModel, type OfferedModels } from "./model-catalog.js";

/** Where a model runs, in words: "Claude Code", or the API it is called through. */
const RUNS_THROUGH: Readonly<Record<string, string>> = Object.freeze({ "claude-code-cli": "Claude Code", "codex-cli": "Codex", "antigravity-cli": "Antigravity", "gemini-cli": "Gemini CLI",
  "anthropic-messages": "Anthropic API", "openai-responses": "OpenAI API", "gemini-native": "Gemini API", "openai-chat": "an OpenAI-compatible endpoint" });
export const runsThrough = (transport: string): string => RUNS_THROUGH[transport] ?? transport;

/**
 * Change models: one row per model of the lineup, chosen from the models known to work through its CLI or API, so an
 * ID cannot be mistyped, and which step each one does. "Another model ID" opens a typed ID and family for a model not
 * listed; an endpoint with no list (an OpenAI-compatible one) is typed.
 */
export function ChangeModels({ draft, edit, offered }: { readonly draft: Draft; readonly edit: Edit; readonly offered: OfferedModels }): ReactElement {
  const profiles = modelProfiles(draft);
  const recommendable = profiles.filter((profile) => profile.placeholder && offeredCatalog(profile.transport, offered) !== undefined);
  return <div className="change-models">
    {recommendable.length === 0 ? null : <p><button className="button" type="button" onClick={() => { for (const profile of recommendable) { const choice = offeredCatalog(profile.transport, offered)?.[0]; if (choice !== undefined) choose(edit, profile.alias, choice); } }}>
      use the recommended models · {recommendable.map((profile) => modelName(offeredCatalog(profile.transport, offered)?.[0]?.modelId ?? "")).join(", ")}</button></p>}
    <div className="table-scroll"><table aria-label="models" className="table">
      <thead><tr><th scope="col">runs through</th><th scope="col">model</th><th scope="col">family</th><th scope="col">steps · effort</th></tr></thead>
      <tbody>{profiles.map((profile) => <tr data-placeholder={profile.placeholder} key={profile.alias}>
        <td>{runsThrough(profile.transport)}<span className="field__hint"> {profile.alias}</span></td>
        <ModelChoice profile={profile} edit={edit} catalog={offeredCatalog(profile.transport, offered)} />
        <td>{profile.roles.map(({ label, node, stage }) => { const effort = roleEffort(draft, profile.alias, stage ?? node); return effort === null ? label : `${label} · ${effort}`; }).join(", ") || "none"}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="field__hint">The first model of each list is the recommended one: the model the measured runs used. Sign-in stays with each CLI, or in the environment variables an API endpoint names.</p>
    <RoleFields draft={draft} edit={edit} profiles={profiles} />
  </div>;
}

const OTHER_MODEL = "other";

function choose(edit: Edit, alias: string, model: CatalogModel): void {
  for (const [path, value] of modelSettings(model)) edit(["models", alias, ...path], value);
}

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

function RoleFields({ draft, edit, profiles }: { readonly draft: Draft; readonly edit: Edit; readonly profiles: readonly ModelProfileSummary[] }): ReactElement | null {
  const slots = roleSlots(draft);
  if (slots.length === 0) return null;
  return <fieldset className="roles"><legend className="panel-title">which model does what</legend><div className="field-row">{slots.map((slot) => <RoleField key={slot.label} slot={slot} draft={draft} edit={edit} profiles={profiles} />)}</div></fieldset>;
}

function RoleField({ slot, draft, edit, profiles }: { readonly slot: RoleSlot; readonly draft: Draft; readonly edit: Edit; readonly profiles: readonly ModelProfileSummary[] }): ReactElement {
  const value = getIn(draft, slot.path);
  const named = (profile: ModelProfileSummary) => profile.placeholder ? profile.alias : `${modelName(profile.modelId)} (${profile.alias})`;
  if (slot.multiple) {
    const chosen = Array.isArray(value) ? value.map(String) : [];
    return <fieldset className="field role-multiple"><legend>{slot.label}</legend>{profiles.map((profile) => <label className="tick" key={profile.alias}><input checked={chosen.includes(profile.alias)} type="checkbox" onChange={() => edit(slot.path, chosen.includes(profile.alias) ? chosen.filter((item) => item !== profile.alias) : [...chosen, profile.alias])} />{named(profile)}</label>)}<span className="field__hint">{slot.hint}</span></fieldset>;
  }
  return <label className="field">{slot.label}
    <select aria-label={slot.label} value={typeof value === "string" ? value : ""} onChange={(event) => edit(slot.path, event.target.value === "" ? undefined : event.target.value)}>
      <option value="">{slot.optional ? "none" : "choose a model"}</option>{profiles.map((profile) => <option key={profile.alias} value={profile.alias}>{named(profile)}</option>)}
    </select>
    <span className="field__hint">{slot.hint}</span>
  </label>;
}
