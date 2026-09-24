import { z } from "zod";
import { runConfigSchema } from "./config.js";
import { traceQuerySchema } from "./trace-browser.js";
import { requirementsApprovalSchema } from "./feature-execution.js";
import { requirementsDraftSchema } from "./requirements.js";
import { CHECKPOINT_ID_PATTERN, checkpointResponseSchema } from "./checkpoint-policy.js";

const idParams = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } } } as const;
const artifactParams = { type: "object", additionalProperties: false, required: ["id", "artifactId"], properties: { ...idParams.properties, artifactId: { type: "string", minLength: 1, maxLength: 256 } } } as const;
const checkpointParams = { type: "object", additionalProperties: false, required: ["id", "checkpointId"], properties: { ...idParams.properties, checkpointId: { type: "string", minLength: 1, maxLength: 128, pattern: CHECKPOINT_ID_PATTERN.source } } } as const;
const runConfigJsonSchema = z.toJSONSchema(runConfigSchema, { target: "draft-7", unrepresentable: "any" });
const { definitions: runConfigDefinitions, ...nestedRunConfigJsonSchema } = runConfigJsonSchema as typeof runConfigJsonSchema & { definitions?: unknown };
const configurationBody = { type: "object", additionalProperties: false, required: ["name", "config"], properties: { name: { type: "string", minLength: 1, maxLength: 200 }, config: nestedRunConfigJsonSchema }, ...(runConfigDefinitions === undefined ? {} : { definitions: runConfigDefinitions }) } as const;
const jsonResponse = { 200: true, 201: true, 202: true } as const;
const runBody = { type: "object", additionalProperties: false, required: ["configurationId"], properties: { configurationId: idParams.properties.id, repository: { type: "string", minLength: 1 } } } as const;
const comparisonSide = { type: "object", additionalProperties: false, required: ["protocolIdentity"], properties: { protocolIdentity: { type: "string", minLength: 1, maxLength: 512 }, runIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 128 } } } } as const;
// HTTP query parameters arrive as text. The runtime performs bounded numeric parsing;
// request body schemas deliberately do not coerce operator-supplied JSON types.
const traceHttpQuerySchema = traceQuerySchema.omit({ offset: true, limit: true }).extend({
  offset: z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^(0|[1-9][0-9]{0,15})$/u)]).optional(),
  limit: z.union([z.number().int().min(1).max(100), z.string().regex(/^(100|[1-9][0-9]?)$/u)]).optional(),
});

export const HTTP_ROUTE_SCHEMAS = Object.freeze({
  "GET /runs/:id/requirements": { params: idParams, response: jsonResponse },
  "POST /runs/:id/requirements/apply-revision": { params: idParams, body: z.toJSONSchema(z.strictObject({ artifactId: z.string().min(1) }), { target: "draft-7" }), response: jsonResponse },
  "POST /runs/:id/requirements/approve": { params: idParams, body: z.toJSONSchema(requirementsApprovalSchema, { target: "draft-7" }), response: jsonResponse },
  "POST /runs/:id/requirements/revise": { params: idParams, body: z.toJSONSchema(z.strictObject({ artifactId: z.string().min(1), draft: requirementsDraftSchema }), { target: "draft-7" }), response: jsonResponse },
  "GET /runs/:id/testing": { params: idParams, response: jsonResponse },
  "GET /runs/:id/testing/change-set": { params: idParams, response: jsonResponse },
  "GET /runs/:id/traces": { params: idParams, querystring: z.toJSONSchema(traceHttpQuerySchema, { target: "draft-7" }), response: jsonResponse },
  "GET /runs/:id/traces/:traceId": { params: { ...idParams, required: ["id", "traceId"], properties: { ...idParams.properties, traceId: { type: "string", pattern: "^(0|[1-9][0-9]*)$", maxLength: 16 } } }, response: jsonResponse },
  "GET /runs/:id/traces/:traceId/artifacts/:slot": { params: { ...idParams, required: ["id", "traceId", "slot"], properties: { ...idParams.properties, traceId: { type: "string", pattern: "^(0|[1-9][0-9]*)$", maxLength: 16 }, slot: { type: "string", pattern: "^(output|input-(0|[1-9][0-9]*))$", maxLength: 32 } } }, response: jsonResponse },
  "GET /configurations": { response: { 200: { type: "array", items: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } } } } },
  "POST /configurations": { body: configurationBody, response: jsonResponse },
  "GET /configurations/:id": { params: idParams, response: jsonResponse },
  "PUT /configurations/:id": { params: idParams, body: configurationBody, response: jsonResponse },
  "POST /configurations/:id/duplicate": { params: idParams, body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200 } } }, response: jsonResponse },
  "POST /configurations/validate": { body: runConfigJsonSchema, response: jsonResponse },
  "GET /configurations/:id/export": { params: idParams, response: jsonResponse },
  "POST /repositories/select": { body: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 } } }, response: jsonResponse },
  "POST /estimate": { body: runBody, response: jsonResponse },
  "POST /runs": { body: runBody, response: jsonResponse },
  "GET /runs/:id": { params: idParams, response: jsonResponse },
  "POST /runs/:id/resume": { params: idParams, response: jsonResponse },
  "GET /runs/:id/events": { params: idParams },
  "POST /runs/:id/cancel": { params: idParams, response: jsonResponse },
  "POST /runs/:id/checkpoints/:checkpointId": { params: checkpointParams, body: z.toJSONSchema(checkpointResponseSchema, { target: "draft-7" }), response: jsonResponse },
  "GET /runs/:id/artifacts": { params: idParams, response: jsonResponse },
  "GET /runs/:id/artifacts/:artifactId": { params: artifactParams, response: jsonResponse },
  "GET /runs/:id/metrics": { params: idParams, response: jsonResponse },
  "POST /runs/compare": { body: { type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: comparisonSide, b: comparisonSide } }, response: jsonResponse },
} as const);

export type HttpRouteKey = keyof typeof HTTP_ROUTE_SCHEMAS;
