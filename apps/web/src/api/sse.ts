import { RunApi, useRehydratedRun } from "./runs.js";
export interface RunEvent { readonly t: string; readonly runId: string; readonly state?: string; readonly nodeId?: string; readonly activityId?: string; readonly reason?: string; readonly replayed?: boolean; readonly attempt?: number; readonly effortCollapse?: string; readonly semanticState?: string }
export function useRunEvents(runId: string | null): readonly RunEvent[] {
  return useRehydratedRun(sharedApi, runId).events;
}
const sharedApi = new RunApi();
