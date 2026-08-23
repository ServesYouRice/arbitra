import type { ReactElement } from "react";
import { modelCardRows, type ModelCardData } from "./model.js";

export interface ModelPoolProps { readonly models: readonly ModelCardData[]; readonly selectedAlias: string | null; readonly onSelect: (alias: string) => void }
export function ModelPool({ models, selectedAlias, onSelect }: ModelPoolProps): ReactElement {
  return <section aria-labelledby="model-pool-title">
    <h2 className="panel-title" id="model-pool-title">model pool</h2>
    <p className="auditor-semantics">1 auditor: single-source · 2 auditors: disagreement requires verification · 3+: risk-weighted consensus</p>
    <div className="model-list">{models.map((model) => <button aria-pressed={model.alias === selectedAlias} className="model-card" data-enabled={model.enabled} key={model.alias} onClick={() => onSelect(model.alias)} type="button">
      {modelCardRows(model).map((row) => <span className={row.state === undefined ? "model-row" : "model-row state"} data-state={row.state} key={row.label}><span>{row.label}</span><strong>{row.value}</strong></span>)}
    </button>)}</div>
  </section>;
}

