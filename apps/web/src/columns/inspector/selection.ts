import type { RunResource } from "../../api/runs.js";
import type { WorkflowJson } from "../graph/layout.js";
import type { ModelCardData } from "../model-pool/model.js";
import type { InspectorSelection } from "./InspectorView.js";
export type WorkflowNode = WorkflowJson["nodes"][number];
export interface InspectorContext { readonly node: WorkflowNode | null; readonly model: ModelCardData | null; readonly configuration: Readonly<Record<string, unknown>>; readonly run: RunResource | null; readonly repository: string | null }
const PLANNER_NODES: readonly string[] = ["planner", "critic"];
export function inspectorSelectionFor({ node, model, configuration, run, repository }: InspectorContext): InspectorSelection {
  if (node === null) return { kind: "workflow", repository: text(repository), snapshot: text(read(configuration, "scope", "snapshot")), base: optional(read(configuration, "scope", "base")), head: optional(read(configuration, "scope", "head")), budgets: text(configuration["budgets"]), concurrency: numeric(read(configuration, "harness", "concurrency")), retries: numeric(read(configuration, "harness", "retries")), outputLocations: list(read(configuration, "harness", "outputLocations")), exclusions: list(read(configuration, "security", "exclusions")), secretSettings: text(read(configuration, "security", "secrets")), protocolVersion: text(configuration["protocols"]), runState: run?.state ?? "unavailable", telemetry: text(read(configuration, "harness", "telemetry")) };
  if (PLANNER_NODES.includes(node.id)) return { kind: "planner", taskGranularity: text(read(configuration, "workflow", "taskGranularity")), routingThresholds: text(read(configuration, "workflow", "routingThresholds")), criticPolicy: text(read(configuration, "verification", "criticPolicy")), validationRules: list(read(configuration, "verification", "validationRules")) };
  if (node.kind === "model") return { kind: "model", model: model?.alias ?? "unassigned", effort: model?.defaultEffort ?? "unavailable", effortCollapse: collapse(model), budget: text(configuration["budgets"]), fallback: model?.fallback ?? null, tools: model?.allowedTools ?? [], outputLimit: model?.contextLimit ?? null, structuredTierDegradation: optional(read(configuration, "harness", "structuredOutputDegradation")) };
  return { kind: "audit", scope: text(read(configuration, "scope", "kind")), depth: text(configuration["auditDepth"]), categories: list(read(configuration, "security", "categories")), consensusPolicy: text(configuration["consensusPolicy"]), rounds: numeric(configuration["maxConsensusRounds"]), tools: model?.allowedTools ?? [], securityOverlapBudget: numeric(read(configuration, "security", "overlapBudget")) };
}
function read(source: Readonly<Record<string, unknown>>, group: string, key: string): unknown { const value = source[group]; return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined; }
function text(value: unknown): string { if (value === undefined || value === null || value === "") return "unavailable"; return typeof value === "object" ? JSON.stringify(value) : String(value); }
function optional(value: unknown): string | null { return value === undefined || value === null || value === "" ? null : String(value); }
function numeric(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function list(value: unknown): readonly string[] { return Array.isArray(value) ? value.map(String) : []; }
function collapse(model: ModelCardData | null): string | null { if (model === null) return null; const entries = Object.entries(model.effortCollapse); return entries.length === 0 ? null : entries.map(([from, to]) => `${from}→${String(to)}`).join(", "); }
