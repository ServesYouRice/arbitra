import { useState, type ReactElement, type ReactNode } from "react";
import type { ModelCardData } from "../columns/model-pool/model.js";
import { ModelPool } from "../columns/model-pool/ModelPool.js";
interface AppShellProps { readonly models: readonly ModelCardData[]; readonly graph: ReactNode; readonly contract: ReactNode; readonly inspector: ReactNode }
export function AppShell({ models, graph, contract, inspector }: AppShellProps): ReactElement { const [selectedModel, setSelectedModel] = useState<string | null>(models[0]?.alias ?? null); return <main className="shell" data-tab="graph"><aside className="shell__column shell__column--models"><header className="wordmark"><img alt="" src={new URL("../assets/brand/mark-triangle-of-error.svg", import.meta.url).href} /><span>arbitra</span></header><ModelPool models={models} selectedAlias={selectedModel} onSelect={setSelectedModel} /></aside><section className="shell__column shell__column--graph">{graph}</section><aside className="shell__column shell__column--contract">{contract}</aside><aside className="shell__column shell__column--inspector">{inspector}</aside></main>; }

