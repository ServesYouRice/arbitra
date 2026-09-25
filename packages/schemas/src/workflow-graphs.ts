import { z } from "zod";

/** Graph IDs appear in file names and URLs, like configuration and run IDs. */
export const WORKFLOW_GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** A saved version is the SHA-256 content address of the graph's canonical JSON. */
export const WORKFLOW_GRAPH_VERSION_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Changes an operator-authored graph may carry only with an explicit, separate
 * authorization. Without one the validator rejects them; the default is rejected.
 */
export const WORKFLOW_GRAPH_AUTHORIZATIONS = ["control_plane", "write_authority", "testing_execution", "shipped_preset_id"] as const;
export type WorkflowGraphAuthorization = typeof WORKFLOW_GRAPH_AUTHORIZATIONS[number];

const graphId = z.string().regex(WORKFLOW_GRAPH_ID_PATTERN);
const graphVersion = z.string().regex(WORKFLOW_GRAPH_VERSION_PATTERN);
const authorize = z.array(z.enum(WORKFLOW_GRAPH_AUTHORIZATIONS)).max(WORKFLOW_GRAPH_AUTHORIZATIONS.length).default([]);

/** `workflow.graph` in a run configuration: one exact saved version, never "latest". */
export const workflowGraphReferenceSchema = z.strictObject({ id: graphId, version: graphVersion });
export type WorkflowGraphReference = z.infer<typeof workflowGraphReferenceSchema>;

/**
 * Validation is the server's. `configurationId` adds the checks that depend on a run
 * configuration: model roles and the checkpoint policy for gate/human nodes.
 */
export const workflowGraphValidateRequestSchema = z.strictObject({
  graph: z.json(),
  configurationId: z.string().regex(WORKFLOW_GRAPH_ID_PATTERN).optional(),
  authorize,
});
export type WorkflowGraphValidateRequest = z.infer<typeof workflowGraphValidateRequestSchema>;

/** Save always creates (or finds) an immutable version; `parentVersion` records lineage. */
export const workflowGraphSaveRequestSchema = workflowGraphValidateRequestSchema.extend({ parentVersion: graphVersion.nullable().default(null) });
export type WorkflowGraphSaveRequest = z.infer<typeof workflowGraphSaveRequestSchema>;

export const workflowGraphDiagnosticSchema = z.strictObject({ code: z.string().min(1), path: z.string(), message: z.string() });
export type WorkflowGraphDiagnostic = z.infer<typeof workflowGraphDiagnosticSchema>;
