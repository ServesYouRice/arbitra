import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PRESET_WORKFLOWS } from "./columns/graph/presets.js";
import "./columns/inspector/inspector.css";
import "./columns/model-pool/model-pool.css";
import type { ModelCardData } from "./columns/model-pool/model.js";
import "./columns/prompt/prompt.css";
import "./configuration/configuration.css";
import "./controls/run-controls.css";
import { ArbitraWorkspace, WORKSPACE_VIEWS, type WorkspaceView } from "./shell/ArbitraWorkspace.js";
import "./shell/shell.css";

const models: readonly ModelCardData[] = Object.freeze([
  { alias: "auditor-a", provider: "unconfigured", modelId: "unavailable", transport: "unavailable", capabilityTier: "balanced", supportsReasoning: false, defaultEffort: "medium", effortCollapse: {}, contextLimit: null, configurationStatus: "missing_environment", priceMetadata: { input: null, output: null, currency: null }, allowedTools: [], independenceGroup: "unconfigured-a", fallback: null, enabled: false },
  { alias: "auditor-b", provider: "unconfigured", modelId: "unavailable", transport: "unavailable", capabilityTier: "balanced", supportsReasoning: false, defaultEffort: "medium", effortCollapse: {}, contextLimit: null, configurationStatus: "missing_environment", priceMetadata: { input: null, output: null, currency: null }, allowedTools: [], independenceGroup: "unconfigured-b", fallback: null, enabled: false },
]);
const defaultConfiguration = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "audit-deep" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
// The workspace is addressable: `?run=<id>` opens a recorded run and `?view=` opens one
// of the four column-two views directly, so a finished run is a link someone can send.
const parameters = new URLSearchParams(window.location.search);
const runId = parameters.get("run");
const requestedView = parameters.get("view");
const preset = parameters.get("preset") ?? "audit-deep";
const workflow = PRESET_WORKFLOWS[preset as keyof typeof PRESET_WORKFLOWS] ?? PRESET_WORKFLOWS["audit-deep"];
const initialView: WorkspaceView = requestedView !== null && requestedView in WORKSPACE_VIEWS ? requestedView as WorkspaceView : "graph";
const root = document.getElementById("root");
if (root === null) throw new Error("ROOT_ELEMENT_MISSING");
createRoot(root).render(<StrictMode><ArbitraWorkspace initialView={initialView} runId={runId} workflow={workflow} models={models} defaultConfiguration={defaultConfiguration} /></StrictMode>);

