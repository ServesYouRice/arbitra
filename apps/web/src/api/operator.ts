import type { TestingOperatorView, TestingVerifiedChangeSet } from "@arbitra/schemas/testing-operator.js";

/**
 * Clients for the Feature requirements routes and the read-only Testing operator routes.
 *
 * The web holds no approval, revision or execution state of its own: every mutation is one
 * of the existing versioned requirements routes, and a stale version comes back as HTTP 409
 * for the operator to reload rather than being retried or merged here.
 */
export interface RequirementsDraft {
  readonly assumptions: readonly { readonly id: string; readonly statement: string; readonly confidence: "low" | "medium" | "high" }[];
  readonly ambiguities: readonly { readonly id: string; readonly question: string; readonly proposedDefault: string; readonly blastRadius: "low" | "medium" | "high" }[];
  readonly acceptance: readonly { readonly id: string; readonly assertion: string }[];
  readonly outOfScope: readonly string[];
}
export interface RequirementsContract extends RequirementsDraft {
  readonly schemaVersion: 1;
  readonly featureRequest: string;
  readonly decision: { readonly mode: "automatic" | "interactive"; readonly acceptedDefaults: readonly { readonly ambiguityId: string; readonly value: string; readonly acceptedBy: "automatic_mode" | "operator" }[] };
}
export interface RequirementsProposal {
  readonly artifactId: string; readonly baseArtifactId: string; readonly reviewArtifactId: string; readonly modelProfileId: string;
  readonly revision: { readonly draft: RequirementsDraft; readonly lineage: readonly { readonly previousRequirementId: string; readonly nextRequirementIds: readonly string[]; readonly rationale: string }[]; readonly addedRequirementIds: readonly string[]; readonly resolutions: readonly { readonly requirementId: string; readonly resolution: string }[] };
}
export interface RequirementsResource { readonly artifactId: string; readonly contract: RequirementsContract; readonly pendingAmbiguityIds: readonly string[]; readonly revisionProposal?: RequirementsProposal }

/** A failed request with its HTTP status and the server's explanation. */
export class OperatorApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`${code} (HTTP ${status})`); }
  get stale(): boolean { return this.status === 409; }
}

export class RequirementsApi {
  constructor(private readonly baseUrl = "") {}
  current(runId: string): Promise<RequirementsResource | null> { return this.request(`/runs/${encodeURIComponent(runId)}/requirements`); }
  approve(runId: string, artifactId: string, ambiguityIds: readonly string[]): Promise<RequirementsResource> { return this.request(`/runs/${encodeURIComponent(runId)}/requirements/approve`, { artifactId, ambiguityIds }); }
  revise(runId: string, artifactId: string, draft: unknown): Promise<RequirementsResource> { return this.request(`/runs/${encodeURIComponent(runId)}/requirements/revise`, { artifactId, draft }); }
  applyRevision(runId: string, artifactId: string): Promise<RequirementsResource> { return this.request(`/runs/${encodeURIComponent(runId)}/requirements/apply-revision`, { artifactId }); }
  private request<T>(path: string, body?: unknown): Promise<T> { return request<T>(`${this.baseUrl}${path}`, body); }
}

export class TestingApi {
  constructor(private readonly baseUrl = "") {}
  view(runId: string): Promise<TestingOperatorView> { return request(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/testing`); }
  changeSet(runId: string): Promise<TestingVerifiedChangeSet> { return request(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/testing/change-set`); }
}

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    let code = "REQUEST_FAILED";
    try { const payload = await response.json() as { message?: unknown; error?: unknown }; code = typeof payload.message === "string" ? payload.message : typeof payload.error === "string" ? payload.error : code; } catch { /* the status alone is the explanation */ }
    throw new OperatorApiError(response.status, code);
  }
  return await response.json() as T;
}

/** Hand the operator a file. Content is serialised data, never interpreted as markup. */
export function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.rel = "noopener";
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function failure(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
