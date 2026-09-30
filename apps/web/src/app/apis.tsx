import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";
import { ArtifactApi } from "../api/artifacts.js";
import { ConfigurationApi } from "../api/configurations.js";
import { RequirementsApi, TestingApi } from "../api/operator.js";
import { RunApi } from "../api/runs.js";
import { WorkflowApi } from "../api/workflows.js";
import { EvaluationApi } from "../views/evaluation/api.js";
import { TraceApi } from "../views/traces/api.js";

/** One client per control-plane surface, shared by every page so their caches are shared too. */
export interface Apis {
  readonly runs: RunApi;
  readonly artifacts: ArtifactApi;
  readonly configurations: ConfigurationApi;
  readonly workflows: WorkflowApi;
  readonly requirements: RequirementsApi;
  readonly testing: TestingApi;
  readonly evaluation: EvaluationApi;
  readonly traces: TraceApi;
}

const ApiContext = createContext<Apis | null>(null);

export function ApiProvider({ apis = {}, children }: { readonly apis?: Partial<Apis>; readonly children: ReactNode }): ReactElement {
  const value = useMemo<Apis>(() => ({
    runs: apis.runs ?? new RunApi(), artifacts: apis.artifacts ?? new ArtifactApi(), configurations: apis.configurations ?? new ConfigurationApi(), workflows: apis.workflows ?? new WorkflowApi(),
    requirements: apis.requirements ?? new RequirementsApi(), testing: apis.testing ?? new TestingApi(), evaluation: apis.evaluation ?? new EvaluationApi(), traces: apis.traces ?? new TraceApi(),
  }), [apis.runs, apis.artifacts, apis.configurations, apis.workflows, apis.requirements, apis.testing, apis.evaluation, apis.traces]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApis(): Apis {
  const apis = useContext(ApiContext);
  if (apis === null) throw new Error("API_CONTEXT_MISSING");
  return apis;
}
