import { redactSecrets } from "@arbitra/security/redaction";
import type { DetectedEnvironment } from "./environment.js";
import type { Orchestrator } from "./orchestrator.js";

/**
 * A run's diagnostic report as plain text, for a tester to copy and send: arbitra's build, the machine, the models it
 * found, the run's settings and outcome, each stage's calls and time, and every failed call with its error. It holds
 * no source code and no model output; every line passes the secret redactor before it leaves.
 */
export async function runReport(orchestrator: Orchestrator, runId: string, environment: DetectedEnvironment | null, build: string): Promise<string> {
  const lines: string[] = [];
  const add = (...values: string[]) => { for (const value of values) lines.push(value); };
  const overview = await orchestrator.overview(runId);
  const traces = await orchestrator.modelTraces(runId);
  add(`arbitra run report · ${new Date().toISOString()}`, `build ${build}`);
  if (environment !== null) {
    add(`machine ${environment.platform} · node ${environment.node}`);
    for (const cli of environment.clis) add(`  ${cli.name}: ${cli.state}${cli.version === null ? "" : ` ${cli.version}`} · ${cli.note}${(cli.others ?? []).map(({ path, version }) => ` · also found ${version ?? "unreadable version"} at ${path}`).join("")}`);
    add(`  API keys set: ${Object.entries(environment.apiKeys).filter(([, set]) => set).map(([name]) => name).join(", ") || "none"}`);
  }
  add("", `run ${runId}`, `  mode ${overview.mode ?? "unknown"} · workflow ${overview.workflowId ?? "unknown"} · state ${overview.state ?? "unreadable"}${overview.reason === null ? "" : ` (${overview.reason})`}${overview.live ? " · running now" : ""}`,
    `  gate ${overview.gate === null ? "not reached" : `${overview.gate.status}${overview.gate.reasons.length === 0 ? "" : ` · ${overview.gate.reasons.join(", ")}`}`}`,
    `  created ${overview.createdAt ?? "unknown"} · last activity ${overview.updatedAt ?? "unknown"}`,
    `  scope ${JSON.stringify(overview.scope)}`);
  const configuration = overview.configuration as { models?: Record<string, { modelId?: string; transport?: string }>; workflow?: { modelExecution?: { roles?: Record<string, string>; stageEffort?: Record<string, string> } }; auditDepth?: string } | null;
  if (configuration?.models !== undefined) {
    add(`  depth ${configuration.auditDepth ?? "default"} · stage effort ${JSON.stringify(configuration.workflow?.modelExecution?.stageEffort ?? {})}`);
    for (const [profile, model] of Object.entries(configuration.models)) add(`  ${profile}: ${model.modelId ?? "?"} via ${model.transport ?? "?"}`);
    add(`  roles ${JSON.stringify(configuration.workflow?.modelExecution?.roles ?? {})}`);
  }
  const metrics = await orchestrator.metrics(runId).catch(() => null);
  const outcome = metrics?.confirmedYield ?? null;
  if (outcome !== null) {
    const severities = Object.entries(outcome.confirmedBySeverity).map(([severity, count]) => `${severity} ${count}`).join(", ");
    add("", "checked against the source",
      `  ${outcome.candidates} candidates · ${outcome.confirmed} confirmed${severities === "" ? "" : ` (${severities})`} · ${outcome.rejected} rejected · ${outcome.unsettled} the source could not settle · ${outcome.acceptedUnchecked} accepted without a check · ${outcome.notChecked} not checked`,
      `  ${outcome.tokens === null ? "tokens not recorded" : `${tokenCount(outcome.tokens)} tokens`}${outcome.tokensPerConfirmed === null ? "" : ` · ${tokenCount(outcome.tokensPerConfirmed)} per confirmed issue`}`);
    for (const auditor of outcome.auditors)
      add(`  ${auditor.auditorId} (${auditor.modelId ?? "?"}): ${auditor.findings} findings · ${auditor.confirmed} confirmed · ${auditor.confirmedAlone} confirmed that no other auditor found · discovery ${auditor.discoveryTokens === null ? "tokens not recorded" : `${tokenCount(auditor.discoveryTokens)} tokens`}`);
  }
  const carried = metrics?.planResults ?? null;
  if (carried !== null) add("", "plan carried out (results.json)", `  ${carried.reported} of ${carried.issues} issues reported · ${carried.provenByFailingTest} proven by a failing test · ${carried.notProvenByTest} no test could show · ${carried.checkedEndToEnd} checked end to end`,
    `  ${Object.entries(carried.results).map(([result, count]) => `${result.replaceAll("_", " ")} ${count}`).join(" · ")}`,
    ...(carried.foundWhileFixing.reported === 0 ? [] : [`  found while fixing, no issue named them: ${carried.foundWhileFixing.reported} · ${carried.foundWhileFixing.provenByFailingTest} proven by a failing test`]));
  const stages = new Map<string, { calls: number; failed: number; ms: number; tokens: number }>();
  for (const trace of traces) {
    const stage = stages.get(trace.nodeId) ?? { calls: 0, failed: 0, ms: 0, tokens: 0 };
    stage.calls += 1; stage.ms += trace.durationMs; if (trace.outcome !== "success") stage.failed += 1;
    stage.tokens += (trace.tokenUsage?.inputTokens ?? 0) + (trace.tokenUsage?.outputTokens ?? 0);
    stages.set(trace.nodeId, stage);
  }
  add("", `model calls ${traces.length} · failed ${traces.filter(({ outcome }) => outcome !== "success").length}`);
  for (const [stage, value] of [...stages.entries()].sort(([left], [right]) => left.localeCompare(right)))
    add(`  ${stage}: ${value.calls} calls · ${value.failed} failed · ${Math.round(value.ms / 60_000 * 10) / 10} call-minutes · ${value.tokens} tokens`);
  const failed = traces.filter(({ outcome }) => outcome !== "success");
  if (failed.length > 0) {
    add("", "failed calls");
    for (const trace of failed.slice(-40)) add(`  ${trace.activityId} · ${trace.modelId} · ${trace.outcome} · ${trace.error?.code ?? trace.refusal ?? ""} ${trace.error?.message.replace(/\s+/gu, " ").slice(0, 300) ?? ""}`);
    if (failed.length > 40) add(`  (${failed.length - 40} earlier failures left out)`);
  }
  return lines.map((line) => redactSecrets(line).text).join("\n");
}

function tokenCount(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value);
}
