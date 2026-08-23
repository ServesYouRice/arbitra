import "@xyflow/react/dist/style.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./columns/graph/graph.css";
import { PRESET_WORKFLOWS } from "./columns/graph/presets.js";
import "./columns/inspector/inspector.css";
import "./columns/model-pool/model-pool.css";
import type { ModelCardData } from "./columns/model-pool/model.js";
import "./columns/prompt/prompt.css";
import "./configuration/configuration.css";
import "./controls/run-controls.css";
import "./views/evaluation/evaluation.css";
import "./views/issue-board/issue-board.css";
import "./views/plan/plan.css";
import { ArbitraWorkspace } from "./shell/ArbitraWorkspace.js";
import "./shell/shell.css";

const models: readonly ModelCardData[] = Object.freeze([
  { alias: "auditor-a", provider: "unconfigured", modelId: "unavailable", transport: "unavailable", capabilityTier: "balanced", supportsReasoning: false, defaultEffort: "medium", effortCollapse: {}, contextLimit: null, configurationStatus: "missing_environment", priceMetadata: { input: null, output: null, currency: null }, allowedTools: [], independenceGroup: "unconfigured-a", fallback: null, enabled: false },
  { alias: "auditor-b", provider: "unconfigured", modelId: "unavailable", transport: "unavailable", capabilityTier: "balanced", supportsReasoning: false, defaultEffort: "medium", effortCollapse: {}, contextLimit: null, configurationStatus: "missing_environment", priceMetadata: { input: null, output: null, currency: null }, allowedTools: [], independenceGroup: "unconfigured-b", fallback: null, enabled: false },
]);
const defaultConfiguration = { schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2, verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "audit-deep" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} };
const root = document.getElementById("root");
if (root === null) throw new Error("ROOT_ELEMENT_MISSING");
createRoot(root).render(<StrictMode><ArbitraWorkspace runId={null} workflow={PRESET_WORKFLOWS["audit-deep"]} models={models} defaultConfiguration={defaultConfiguration} /></StrictMode>);

