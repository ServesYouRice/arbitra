import { lazy, Suspense, useCallback, useEffect, useState, type ReactElement } from "react";
import { useConfigurations } from "../api/configurations.js";
import type { GraphVersionRecord } from "../api/workflows.js";
import { useApis } from "../app/apis.js";
import { Link, useNavigation } from "../app/router.js";

// The editor carries React Flow and elkjs; only this page needs them.
const GraphEditor = lazy(async () => ({ default: (await import("../graph/GraphEditor.js")).GraphEditor }));
const LEAVE = { title: "unsaved graph changes", description: "The edited graph has not been saved as a version. Leaving the editor discards those changes." } as const;

/**
 * Operator-authored workflow graphs for Audit runs. The server validates every edit and
 * saves immutable versions; a run names one by ID and version, which the link after a save
 * fills in for you.
 */
export function WorkflowsPage({ source }: { readonly source: string | null }): ReactElement {
  const apis = useApis();
  const { setGuard } = useNavigation();
  const { configurations } = useConfigurations(apis.configurations);
  const [configurationId, setConfigurationId] = useState("");
  const [saved, setSaved] = useState<GraphVersionRecord | null>(null);
  const dirtyChanged = useCallback((dirty: boolean): void => setGuard(dirty ? LEAVE : null), [setGuard]);
  useEffect(() => () => setGuard(null), [setGuard]);
  return <>
    <div className="page-head"><div className="page-head__text">
      <h1 className="page-title">Workflows</h1>
      <p className="lead">Edit the graph an Audit run executes, then save it as a version. The server checks every edit; a graph it refuses cannot be saved.</p>
    </div></div>
    <section aria-labelledby="validation-context-title" className="surface form-section">
      <h2 className="panel-title" id="validation-context-title">check against</h2>
      <label className="field">configuration<select aria-label="check against configuration" value={configurationId} onChange={(event) => setConfigurationId(event.target.value)}>
        <option value="">none · check the graph's structure only</option>
        {configurations.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <p className="field__hint">With a configuration, validation also checks that its model profiles cover every model node and that its checkpoint policy covers every human and gate node.</p>
    </section>
    {saved === null ? null : <p className="state" data-state="verified" role="status">saved {saved.graphId} @ {saved.version} · <Link to={{ page: "new-run", from: null, graph: `${saved.graphId}@${saved.version}` }}>start an Audit run with this graph</Link></p>}
    <div className="surface">
      <Suspense fallback={<p className="state" data-state="unexamined" role="status">loading the editor</p>}>
        <GraphEditor api={apis.workflows} configurationId={configurationId === "" ? null : configurationId} preferredSource={source} onDirtyChange={dirtyChanged} onSaved={setSaved} />
      </Suspense>
    </div>
  </>;
}
