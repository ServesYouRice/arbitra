import { z } from "zod";
import { runConfigSchema } from "./config.js";

const idParams = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } } } as const;
const artifactParams = { type: "object", additionalProperties: false, required: ["id", "artifactId"], properties: { ...idParams.properties, artifactId: { type: "string", minLength: 1, maxLength: 256 } } } as const;
const checkpointParams = { type: "object", additionalProperties: false, required: ["id", "checkpointId"], properties: { ...idParams.properties, checkpointId: { type: "string", minLength: 1, maxLength: 128 } } } as const;
const runConfigJsonSchema = z.toJSONSchema(runConfigSchema, { target: "draft-7", unrepresentable: "any" });
const { definitions: runConfigDefinitions, ...nestedRunConfigJsonSchema } = runConfigJsonSchema as typeof runConfigJsonSchema & { definitions?: unknown };
const configurationBody = { type: "object", additionalProperties: false, required: ["name", "config"], properties: { name: { type: "string", minLength: 1, maxLength: 200 }, config: nestedRunConfigJsonSchema }, ...(runConfigDefinitions === undefined ? {} : { definitions: runConfigDefinitions }) } as const;
const jsonResponse = { 200: true, 201: true, 202: true } as const;
const bodyObject = { type: "object" } as const;
const comparisonSide = { type: "object", additionalProperties: false, required: ["protocolIdentity"], properties: { protocolIdentity: { type: "string", minLength: 1, maxLength: 512 }, runIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 128 } } } } as const;

export const HTTP_ROUTE_SCHEMAS = Object.freeze({
  "GET /configurations": { response: { 200: { type: "array", items: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } } } } },
  "POST /configurations": { body: configurationBody, response: jsonResponse },
  "GET /configurations/:id": { params: idParams, response: jsonResponse },
  "PUT /configurations/:id": { params: idParams, body: configurationBody, response: jsonResponse },
  "POST /configurations/:id/duplicate": { params: idParams, body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200 } } }, response: jsonResponse },
  "POST /configurations/validate": { body: runConfigJsonSchema, response: jsonResponse },
  "GET /configurations/:id/export": { params: idParams, response: jsonResponse },
  "POST /repositories/select": { body: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 } } }, response: jsonResponse },
  "POST /estimate": { body: bodyObject, response: jsonResponse },
  "POST /runs": { body: bodyObject, response: jsonResponse },
  "GET /runs/:id": { params: idParams, response: jsonResponse },
  "POST /runs/:id/resume": { params: idParams, response: jsonResponse },
  "GET /runs/:id/events": { params: idParams },
  "POST /runs/:id/cancel": { params: idParams, response: jsonResponse },
  "POST /runs/:id/checkpoints/:checkpointId": { params: checkpointParams, body: { type: "object", additionalProperties: false, required: ["decision"], properties: { decision: { type: "string", minLength: 1 } } }, response: jsonResponse },
  "GET /runs/:id/artifacts": { params: idParams, response: jsonResponse },
  "GET /runs/:id/artifacts/:artifactId": { params: artifactParams, response: jsonResponse },
  "GET /runs/:id/metrics": { params: idParams, response: jsonResponse },
  "POST /runs/compare": { body: { type: "object", additionalProperties: false, required: ["a", "b"], properties: { a: comparisonSide, b: comparisonSide } }, response: jsonResponse },
} as const);

export type HttpRouteKey = keyof typeof HTTP_ROUTE_SCHEMAS;
