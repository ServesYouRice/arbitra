import { useEffect, useState } from "react";
export interface RunEvent { readonly t: string; readonly runId: string; readonly state?: string; readonly nodeId?: string; readonly activityId?: string; readonly reason?: string; readonly replayed?: boolean; readonly attempt?: number; readonly effortCollapse?: string; readonly semanticState?: string }
export function useRunEvents(runId: string | null): readonly RunEvent[] {
  const [events, setEvents] = useState<readonly RunEvent[]>([]);
  useEffect(() => { if (runId === null) { setEvents([]); return; } const source = new EventSource(`/runs/${encodeURIComponent(runId)}/events`); source.onmessage = ({ data }) => { const value = JSON.parse(data as string) as RunEvent; setEvents((current) => Object.freeze([...current, value])); }; return () => source.close(); }, [runId]);
  return events;
}
