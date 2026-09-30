import auditCompatibleChat from "../../../../../examples/model-backed/audit-compatible-chat.json" with { type: "json" };
import auditMixedProviders from "../../../../../examples/model-backed/audit-mixed-providers.json" with { type: "json" };
import featureAutomatic from "../../../../../examples/model-backed/feature-automatic.json" with { type: "json" };
import featureInteractive from "../../../../../examples/model-backed/feature-interactive.json" with { type: "json" };
import subscriptionAudit from "../../../../../examples/model-backed/subscription-audit.json" with { type: "json" };
import subscriptionFeatureAutomatic from "../../../../../examples/model-backed/subscription-feature-automatic.json" with { type: "json" };
import subscriptionFeatureInteractive from "../../../../../examples/model-backed/subscription-feature-interactive.json" with { type: "json" };
import subscriptionTestingExecute from "../../../../../examples/model-backed/subscription-testing-execute.json" with { type: "json" };
import subscriptionTestingPlan from "../../../../../examples/model-backed/subscription-testing-plan.json" with { type: "json" };
import testingExecute from "../../../../../examples/model-backed/testing-execute.json" with { type: "json" };
import testingPlan from "../../../../../examples/model-backed/testing-plan.json" with { type: "json" };
import type { Draft, Mode } from "./draft.js";

/**
 * Where a new configuration starts. The model-backed entries are the repository's own
 * templates (`examples/model-backed/`), which `pnpm run validate:examples` keeps passing
 * preflight; they name no real model, so their placeholders are listed for the operator
 * to fill in. The scripted Audit needs nothing and calls no model.
 */
export interface Template { readonly id: string; readonly mode: Mode; readonly label: string; readonly description: string; readonly config: Draft }

export const SCRIPTED_AUDIT: Draft = Object.freeze({ schemaVersion: 1, mode: "audit", scope: { kind: "repository" }, auditDepth: "balanced", consensusPolicy: "risk_weighted", maxConsensusRounds: 2,
  verification: {}, models: {}, harness: { mode: "canonical" }, workflow: { preset: "audit-deep" }, budgets: {}, security: {}, protocols: {}, promptOverrides: {}, contextPolicies: {} });

const SUBSCRIPTION = "Signed in through the vendors' CLIs with your subscriptions; no API key is used.";
const EXECUTE = "Writes and runs tests in a Docker sandbox, so it needs Docker and a pinned image; its write grants and checks name example paths to adapt.";

export const TEMPLATES: readonly Template[] = Object.freeze([
  { id: "scripted-audit", mode: "audit", label: "Audit · scripted detectors (smoke test)", description: "Deterministic detectors stand in for the auditors. No model is called and nothing is spent: the run shows the pipeline works, not what models find.", config: SCRIPTED_AUDIT },
  { id: "subscription-audit", mode: "audit", label: "Audit · three auditors on subscription CLIs", description: `Claude Code, Codex and Antigravity audit independently (audit-deep). ${SUBSCRIPTION}`, config: subscriptionAudit },
  { id: "audit-mixed-providers", mode: "audit", label: "Audit · three auditors on API keys", description: "OpenAI Responses, Anthropic Messages and Gemini endpoints audit independently (audit-deep), each with its own API key variable.", config: auditMixedProviders },
  { id: "audit-compatible-chat", mode: "audit", label: "Audit · two auditors on OpenAI-compatible endpoints", description: "Two auditors on OpenAI-compatible chat endpoints, such as a local model server (audit-balanced).", config: auditCompatibleChat },
  { id: "subscription-feature-interactive", mode: "feature", label: "Feature · subscription CLIs · you approve defaults", description: `Plans a feature and stops for your approval of high-impact defaults. ${SUBSCRIPTION}`, config: subscriptionFeatureInteractive },
  { id: "subscription-feature-automatic", mode: "feature", label: "Feature · subscription CLIs · automatic", description: `Plans a feature and accepts proposed defaults automatically. ${SUBSCRIPTION}`, config: subscriptionFeatureAutomatic },
  { id: "feature-interactive", mode: "feature", label: "Feature · API keys · you approve defaults", description: "Plans a feature on API-key endpoints and stops for your approval of high-impact defaults.", config: featureInteractive },
  { id: "feature-automatic", mode: "feature", label: "Feature · API keys · automatic", description: "Plans a feature on API-key endpoints and accepts proposed defaults automatically.", config: featureAutomatic },
  { id: "subscription-testing-plan", mode: "testing", label: "Testing · subscription CLIs · plan only", description: `Finds untested risks and plans tests; nothing is written or run. ${SUBSCRIPTION}`, config: subscriptionTestingPlan },
  { id: "subscription-testing-execute", mode: "testing", label: "Testing · subscription CLIs · write and run tests", description: `Plans tests, then writes and verifies them. ${EXECUTE} ${SUBSCRIPTION}`, config: subscriptionTestingExecute },
  { id: "testing-plan", mode: "testing", label: "Testing · API keys · plan only", description: "Finds untested risks and plans tests on API-key endpoints; nothing is written or run.", config: testingPlan },
  { id: "testing-execute", mode: "testing", label: "Testing · API keys · write and run tests", description: `Plans tests on API-key endpoints, then writes and verifies them. ${EXECUTE}`, config: testingExecute },
]);
