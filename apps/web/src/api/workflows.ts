/**
 * Client for the operator-authored workflow graph routes.
 *
 * The web never decides whether a graph is valid: every check is the server's validator,
 * and a save is refused there, not here. Diagnostics and labels are untrusted text and are
 * rendered only as text.
 */
export type NodeKind = "deterministic" | "model" | "gate" | "loop" | "human" | "subgraph";
export type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface GoalContract { readonly objective: string; readonly doneWhen: readonly string[]; readonly stopWhen: readonly string[]; readonly blockedWhen: readonly string[] }
export interface AuthoredNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly goal: GoalContract;
  readonly config?: Readonly<Record<string, JsonValue>>;
  readonly maximum?: number;
  readonly purpose?: string;
}
export type ContextMode = "none" | "selected_artifacts" | "summary" | "delta" | "recent_turns" | "full_context";
export type ContextTrust = "system" | "derived" | "untrusted";
export interface AuthoredEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly input: { readonly artifacts: readonly string[] };
  readonly prompt: { readonly protocolLayers: readonly string[] };
  readonly context: { readonly policy: { readonly mode: ContextMode; readonly trust: ContextTrust; readonly include: readonly string[]; readonly exclude: readonly string[] }; readonly tokenEstimate: number | null };
  readonly output: { readonly schema: string; readonly requiredFields: readonly string[]; readonly validationBehaviour: "strict" | "repair_once" };
}
export interface AuthoredGraph {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly goal: GoalContract;
  readonly entryNodeId: string;
  readonly nodes: readonly AuthoredNode[];
  readonly edges: readonly AuthoredEdge[];
}
export interface GraphDiagnostic { readonly code: string; readonly path: string; readonly message: string }
export interface GraphValidation { readonly valid: boolean; readonly version: string | null; readonly diagnostics: readonly GraphDiagnostic[]; readonly privileged: readonly { readonly category: string; readonly path: string; readonly message: string }[]; readonly configurationChecked: boolean }
export interface GraphVersionSummary { readonly graphId: string; readonly version: string; readonly parentVersion: string | null; readonly savedAt: string; readonly authorizations: readonly string[] }
export interface GraphVersionRecord extends GraphVersionSummary { readonly graph: AuthoredGraph }
export interface GraphListing { readonly graphs: readonly { readonly graphId: string; readonly versions: readonly GraphVersionSummary[] }[]; readonly templates: readonly AuthoredGraph[] }

/** A refused request with the server's explanation (for a refused save, its diagnostic codes). */
export class WorkflowApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`${code} (HTTP ${status})`); }
}

export class WorkflowApi {
  constructor(private readonly baseUrl = "") {}
  list(): Promise<GraphListing> { return this.request("/workflows"); }
  version(graphId: string, version: string): Promise<GraphVersionRecord> { return this.request(`/workflows/${encodeURIComponent(graphId)}/versions/${encodeURIComponent(version)}`); }
  validate(graph: AuthoredGraph, configurationId: string | null): Promise<GraphValidation> {
    return this.request("/workflows/validate", { method: "POST", body: JSON.stringify({ graph, ...(configurationId === null ? {} : { configurationId }) }) });
  }
  save(graph: AuthoredGraph, parentVersion: string | null, configurationId: string | null): Promise<{ readonly record: GraphVersionRecord; readonly created: boolean; readonly validation: GraphValidation }> {
    return this.request("/workflows", { method: "POST", body: JSON.stringify({ graph, parentVersion, ...(configurationId === null ? {} : { configurationId }) }) });
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers } });
    if (!response.ok) {
      let code = `WORKFLOW_API_${response.status}`;
      try { const body = await response.json() as { message?: unknown }; if (typeof body.message === "string") code = body.message; } catch { /* keep the status code */ }
      throw new WorkflowApiError(response.status, code);
    }
    return await response.json() as T;
  }
}
