import { NODE_GLYPHS, STATE_LABELS } from "@arbitra/schemas/glyphs";

import type { ImplementationManifest, ManifestTask } from "../manifest.js";
import { executionPolicy } from "../manifest.js";
import { TRUST_WARNING } from "../entrypoints/index.js";
import { frameUntrusted, inlineCode, markdownFile } from "./neutralize.js";

export function renderReadme(manifest: ImplementationManifest): string {
  const degradations = manifest.run.degradations ?? [];
  return markdownFile([
    `# ${inlineCode(manifest.run.repository)} implementation plan`,
    `> **Trust warning.** ${TRUST_WARNING}`,
    "`manifest.json` is canonical and authoritative. Every Markdown contract in this tree is a deterministic projection of it.",
    "## Run",
    `Run ${inlineCode(manifest.run.runId)} · mode ${inlineCode(manifest.run.mode)} · tasks ${manifest.tasks.length} · validation assertions ${manifest.validation.length}.`,
    "## Presentation vocabulary",
    `${NODE_GLYPHS.deterministic.glyph} **${NODE_GLYPHS.deterministic.label}** — ${NODE_GLYPHS.deterministic.meaning}`,
    `${NODE_GLYPHS.model.glyph} **${NODE_GLYPHS.model.label}** — ${NODE_GLYPHS.model.meaning}`,
    `- **dissent** — ${STATE_LABELS.dissent}`,
    `- **provenance / tainted** — ${STATE_LABELS.tainted}`,
    `- **null / unexamined** — ${STATE_LABELS.unexamined}`,
    `- **degraded** — ${STATE_LABELS.degraded}`,
    "These states use explicit labels and never rely on colour alone.",
    "## Degraded coverage",
    degradations.length > 0 ? degradations.map(({ field, reason, statement }) => `${inlineCode(field)} / ${inlineCode(reason)}\n${frameUntrusted(statement)}`).join("\n\n") : "No degraded coverage was recorded.",
    "## Reading order",
    "Start with `AGENTS.md`, then read only its selected task, bounded read-first context, effective scope, and verification contract.",
  ]);
}

export function renderProjectContext(manifest: ImplementationManifest): string {
  return markdownFile(["# Project context", `Repository: ${inlineCode(manifest.run.repository)}. Mode: ${inlineCode(manifest.run.mode)}.`, frameUntrusted(manifest.run.snapshot?.note ?? "No snapshot note supplied."), "## Snapshot paths", listCode(manifest.run.snapshot?.files ?? [])]);
}

export function renderArchitectureContext(manifest: ImplementationManifest): string {
  const components = [...new Set(manifest.tasks.flatMap((task) => task.scope.components ?? []))].sort();
  const roots = [...new Set(manifest.tasks.flatMap((task) => task.scope.likelyFiles.map((path) => path.replaceAll("\\", "/").split("/").slice(0, 2).join("/"))))].filter(Boolean).sort();
  return markdownFile(["# Architecture context", "## Components", components.length > 0 ? components.map(frameUntrusted).join("\n\n") : "None recorded.", "## Owned repository roots", listCode(roots)]);
}

export function renderInvariantContext(manifest: ImplementationManifest): string {
  const invariants = [...new Set(manifest.tasks.flatMap((task) => task.invariants ?? []))].sort();
  return markdownFile(["# Invariants", invariants.length > 0 ? invariants.map(frameUntrusted).join("\n\n") : "No task invariants recorded."]);
}

export function renderRequirements(manifest: ImplementationManifest): string {
  return markdownFile(["# Requirements contract", "## Assumptions", renderRecords(manifest.requirements.assumptions, "statement"), "## Ambiguities", renderRecords(manifest.requirements.ambiguities, "question"), "## Acceptance", renderRecords(manifest.requirements.acceptance, "assertion"), "## Unresolved questions", renderRecords(manifest.unresolvedQuestions ?? [], "question")]);
}

export function renderIssue(issue: NonNullable<ImplementationManifest["issues"]>[number]): string {
  const facts = [
    ...(issue.severity === undefined ? [] : [`Severity: ${inlineCode(issue.severity)}.`]),
    ...(issue.foundBy === undefined ? [] : [`Reported by ${issue.foundBy} independent auditor${issue.foundBy === 1 ? "" : "s"}.`]),
    ...(issue.verification === undefined ? [] : [`Verification: ${inlineCode(issue.verification.outcome ?? "not verified")}${issue.verification.confidence === null ? "" : `, confidence ${issue.verification.confidence}`}.`]),
  ];
  const audit = issue.locations === undefined && issue.evidence === undefined ? [] : [
    "## Where", listCode(issue.locations ?? []),
    ...(issue.trigger === undefined ? [] : ["## Trigger", frameUntrusted(issue.trigger)]),
    "## Evidence", issue.evidence?.length ? issue.evidence.map(({ text, locations }) => `${listInline(locations)}\n${frameUntrusted(text)}`).join("\n\n") : "No quoted evidence recorded.",
  ];
  const reproduce = issue.reproduceFirst !== true ? [] : [
    "## Reproduce first",
    "Before changing code, write a test that fails on the current code for the reason this issue gives, and that passes once the fix is in. If no such test can be written, record why as the issue's proof gap and go on. Never edit or remove an existing test to make a check pass.",
    "## Result",
    `Report this issue's result in ${inlineCode("progress.jsonl")} with the task that addresses it: ${inlineCode("fixed")}, ${inlineCode("not_reproducible")}, ${inlineCode("no_change_needed")} or ${inlineCode("blocked")}, with the test or the reason as proof.`,
  ];
  return markdownFile([`# ${inlineCode(issue.id)}`, `Status: ${inlineCode(issue.status ?? "unknown")}. Provenance is retained.`, ...(facts.length === 0 ? [] : [facts.join(" ")]), frameUntrusted(issue.title ?? "Untitled issue"), frameUntrusted(issue.description ?? "No description supplied."), ...audit, ...reproduce, "## Dissent", issue.dissent?.length ? issue.dissent.map(frameUntrusted).join("\n\n") : "No dissent recorded.", "## Provenance", listCode(issue.provenance ?? [])]);
}

export function renderTask(task: ManifestTask, writeScope: readonly string[], readFirst: readonly string[]): string {
  const commands = task.verification.commands.map((command) => {
    const policy = executionPolicy(command.executionPolicy);
    const runnable = policy === "requires_approval" ? " **NOT RUNNABLE without explicit approval**" : " runnable only after policy re-resolution";
    return `- ${inlineCode(command.command)} — executionPolicy: ${inlineCode(policy)}; expected exit ${command.expectedExitCode}.${runnable}`;
  }).join("\n");
  return markdownFile([
    `# ${inlineCode(task.id)}`,
    `> **Trust warning.** ${TRUST_WARNING}`,
    frameUntrusted(task.title),
    "## Goal", frameUntrusted(task.goal.objective),
    "## Done when", task.goal.doneWhen.map(frameUntrusted).join("\n\n"),
    "## Traceability", `Issues: ${listInline(task.addresses.issues ?? [])}. Requirements: ${listInline(task.addresses.requirements)}. Validation: ${listInline(task.addresses.validation)}.`,
    "## Dependencies", `Depends on: ${listInline(task.dependencies.dependsOn)}. Blocks: ${listInline(task.dependencies.blocks ?? [])}.`,
    "## Effective write scope", writeScope.length > 0 ? listCode(writeScope) : "Empty — this task is display-only.",
    "## Read first", readFirst.length > 0 ? listCode(readFirst) : "None.",
    "## Context", (task.context ?? []).map(frameUntrusted).join("\n\n"),
    "## Invariants", (task.invariants ?? []).map(frameUntrusted).join("\n\n"),
    "## Acceptance", task.acceptanceCriteria.map(frameUntrusted).join("\n\n"),
    "## Verification", commands,
    "## Rollback", (task.rollbackPlan ?? []).map(frameUntrusted).join("\n\n"),
    "## Escalate if", (task.escalateIf ?? []).map(frameUntrusted).join("\n\n"),
  ]);
}

export function renderTaskIndex(manifest: ImplementationManifest): string {
  return markdownFile(["# Task index", ...[...manifest.tasks].sort((left, right) => left.id.localeCompare(right.id)).map((task) => `- ${inlineCode(task.id)} · phase ${inlineCode(task.phase)} · [contract](${task.id}/task.md)`) ]);
}

export function renderValidation(manifest: ImplementationManifest): string {
  return markdownFile(["# Final validation", ...manifest.validation.map(({ id, assertion, evidence = [], addresses = [] }) => [`## ${inlineCode(id)}`, frameUntrusted(assertion), `Addresses: ${listInline(addresses)}.`, "Evidence:", evidence.map(frameUntrusted).join("\n\n")].join("\n\n"))]);
}

export function renderExecutionReadme(manifest: ImplementationManifest): string {
  return markdownFile(["# Execution state", `Run: ${inlineCode(manifest.run.runId)}.`, "This directory contains status data only. It cannot alter authority, scope, commands, task contracts, context, or validation.", "Allowed executor writes are append-only `implementation/progress.jsonl` and the current `implementation/execution/TASK-ID/` subtree."]);
}

function renderRecords(records: readonly Record<string, unknown>[], textField: string): string {
  return records.length > 0 ? records.map((record) => `${inlineCode(record.id)}\n${frameUntrusted(record[textField] ?? record.statement ?? "")}`).join("\n\n") : "None recorded.";
}
function listCode(values: readonly string[]): string { return values.length > 0 ? values.map((value) => `- ${inlineCode(value)}`).join("\n") : "None."; }
function listInline(values: readonly string[]): string { return values.length > 0 ? values.map(inlineCode).join(", ") : "none"; }
