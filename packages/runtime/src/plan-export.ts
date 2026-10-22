import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Orchestrator } from "./orchestrator.js";

interface ExportTask {
  readonly id: string; readonly title: string;
  readonly goal: { readonly objective: string; readonly doneWhen: readonly string[] };
  readonly addresses: { readonly issues: readonly string[] };
  readonly routing: { readonly capability: "frontier" | "balanced" | "fast"; readonly effort: string; readonly reason: readonly string[] };
  readonly dependencies: { readonly dependsOn: readonly string[] };
  readonly scope: { readonly likelyFiles: readonly string[] };
  readonly filesNotToTouch: readonly string[]; readonly readFirst: readonly string[]; readonly context: readonly string[]; readonly invariants: readonly string[];
  readonly outOfScope: readonly string[]; readonly implementationGuidance: readonly string[]; readonly acceptanceCriteria: readonly string[];
  readonly verification: { readonly preconditions: readonly string[]; readonly commands: readonly { readonly command: string; readonly expectedExitCode: number; readonly executionPolicy: string }[]; readonly checks: readonly string[] };
  readonly rollbackPlan: readonly string[];
}
interface ExportPlan { readonly title: string; readonly tasks: readonly ExportTask[]; readonly unresolvedQuestions: readonly { readonly id: string; readonly question: string; readonly blocking: boolean }[] }
interface ExportIssue {
  readonly candidateId: string; readonly severity: string; readonly disposition: string; readonly claim: { readonly title: string; readonly description: string };
  readonly verificationOutcome?: string | null; readonly dissent?: readonly { readonly authorId: string; readonly disposition: string; readonly reason: string }[];
}
const SEVERITIES = ["informational", "low", "medium", "high", "critical"];
const CHECK_FIRST = "0-check-first";
/** The executor's report, one entry per issue, which arbitra reads back (`plan-results.ts`). */
export const RESULTS_FILE = "results.json";
export const RESULT_VALUES = ["fixed", "not_reproducible", "no_change_needed", "blocked"] as const;
const REPRODUCE_FIRST = "Before changing code, write a test that fails on the current code for the reason the issue gives, run it, and keep its failing output. Then fix it; the same test must pass. If no test can show the defect, say why in results.json and go on. Never edit or remove an existing test to make a check pass.";

const TIERS = {
  frontier: { folder: "1-strong-model", model: "your strongest model (such as Claude Opus)", why: "reasoning across files, or a fix that is easy to get subtly wrong" },
  balanced: { folder: "2-balanced-model", model: "a balanced model (such as Claude Sonnet)", why: "a contained change with a clear target" },
  fast: { folder: "3-fast-model", model: "a fast, inexpensive model (such as Claude Haiku)", why: "a small, mechanical change" },
} as const;

/**
 * Writes a run's plan into its repository as prompts a person or a coding agent can use directly, in
 * `.arbitra/plans/<date>-<run>/`: a README with the order of work, AGENTS.md (and CLAUDE.md) telling a coding agent how
 * to work through it, a PROGRESS.md checklist, one prompt per task grouped by the model tier the
 * planner chose for it, the issues they fix, a prompt to check each issue of the plan's scope the audit left open, and
 * the accepted issues no task fixes. Each prompt follows Anthropic's prompting guidance: a role, the
 * context and why it matters, the material in tagged sections, clear steps, explicit success criteria and how to
 * check them. Only this explicit action writes to the repository; runs themselves never do.
 */
export async function exportPlan(orchestrator: Orchestrator, runId: string): Promise<{ readonly directory: string; readonly files: readonly string[] }> {
  const overview = await orchestrator.overview(runId);
  if (overview.repository === null) throw Object.assign(new Error("RUN_REPOSITORY_UNKNOWN"), { statusCode: 409 });
  const artifacts = await orchestrator.artifacts(runId);
  const read = async <T>(kind: string): Promise<T | null> => {
    const descriptor = [...artifacts].reverse().find((entry) => entry.kind === kind);
    if (descriptor === undefined) return null;
    const value = await orchestrator.artifact(runId, descriptor.artifactId) as { content?: string };
    return typeof value.content === "string" ? JSON.parse(value.content) as T : null;
  };
  const plan = await read<ExportPlan>("plan-ir");
  if (plan === null) throw Object.assign(new Error("RUN_HAS_NO_PLAN"), { statusCode: 409 });
  const issues = new Map(((await read<{ issues: readonly ExportIssue[] }>("canonical-issues"))?.issues ?? []).map((issue) => [issue.candidateId, issue]));
  const ordered = topological(plan.tasks);
  const scope = await read<{ minimumSeverity?: string }>("plan-scope");
  const unsettled = unsettledIssues([...issues.values()], ordered, scope?.minimumSeverity ?? null);
  const unverified = [...issues.values()].filter((issue) => isUnresolved(issue) && (issue.verificationOutcome ?? null) === null && !unsettled.includes(issue)).length;
  // Issues the reviewers agreed are real that no task fixes, most below the plan's minimum severity, so none is lost.
  const planned = new Set(ordered.flatMap((task) => task.addresses.issues));
  const alsoFound = [...issues.values()].filter((issue) => (issue.disposition === "accepted" || issue.disposition === "verified_single_source") && !planned.has(issue.candidateId))
    .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity));
  const kept = ((await read<{ issues: readonly SeverityKept[] }>("severity-restored"))?.issues ?? []).map((entry) => ({ ...entry, title: issues.get(entry.candidateId)?.claim.title ?? entry.candidateId }));
  const stamp = new Date().toISOString().slice(0, 10);
  // Saving again keeps the earlier copy (and any progress ticked in it) and writes a new folder beside it.
  const base = join(overview.repository, ".arbitra", "plans", `${stamp}-${runId.replace(/^run-/u, "").slice(0, 8)}`);
  let directory = base;
  for (let copy = 2; existsSync(directory); copy += 1) directory = `${base}-${copy}`;
  const files = new Map<string, string>();
  unsettled.forEach((issue, index) => files.set(join("prompts", CHECK_FIRST, `${String(index + 1).padStart(2, "0")}-${issue.candidateId}.md`), checkPrompt(issue)));
  ordered.forEach((task, index) => files.set(join("prompts", TIERS[task.routing.capability].folder, `${String(index + 1).padStart(2, "0")}-${task.id}.md`), prompt(task, issues, plan.tasks)));
  files.set("README.md", readme(plan, ordered, runId, overview.workflowId ?? "unknown", { unsettled, unverified, alsoFound: alsoFound.length, kept }));
  if (alsoFound.length > 0) files.set("also-found.md", ["# Also found, not planned", "",
    "The reviewers agreed these are real, but no task fixes them; most are below the plan's minimum severity. Fix them when convenient: each says where the defect is and what goes wrong.", "",
    ...alsoFound.map((issue) => `## ${issue.claim.title}\n\n${issue.severity} · ${issue.candidateId}\n\n${issue.claim.description}\n`)].join("\n"));
  // A coding agent opened on the project, or on this folder alone, finds its instructions here; CLAUDE.md points
  // Claude Code at the same file.
  files.set("AGENTS.md", agents(ordered, unsettled.length));
  files.set("CLAUDE.md", "Read AGENTS.md in this folder and follow it.\n");
  files.set("PROGRESS.md", ["# Progress", "", "Tick a task when it is done and verified; note anything left open under it.", "",
    ...unsettled.map((issue, index) => `- [ ] check ${String(index + 1).padStart(2, "0")} \`${issue.candidateId}\` ${issue.claim.title}`),
    ...ordered.map((task, index) => `- [ ] ${String(index + 1).padStart(2, "0")} \`${task.id}\` ${task.title}`), ""].join("\n"));
  files.set("issues.md", ["# Issues this plan fixes", "", ...[...new Set(ordered.flatMap((task) => task.addresses.issues))].map((id) => issues.get(id)).filter((issue): issue is ExportIssue => issue !== undefined)
    .map((issue) => `## ${issue.claim.title}\n\n${issue.severity} · ${issue.disposition} · ${issue.candidateId}\n\n${issue.claim.description}\n`)].join("\n"));
  files.set(RESULTS_FILE, `${JSON.stringify(resultsTemplate(runId, unsettled, ordered, issues), null, 2)}\n`);
  await mkdir(directory, { recursive: true });
  for (const [path, content] of files) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content, { encoding: "utf8", flag: "wx" });
  }
  return { directory, files: [...files.keys()].map((path) => relative(overview.repository ?? "", join(directory, path))) };
}

/** Instructions for a coding agent working through the folder, after Anthropic's guidance for agentic work: one task at a time, verify before moving on, keep state in a file. */
function agents(ordered: readonly ExportTask[], checks: number): string {
  return ["# Working through this plan", "",
    "This folder is a plan to fix defects found in the project it sits in. It was written by arbitra, which audited the project with several models and checked each finding against the code.", "",
    "How to work:", "",
    "1. Read README.md for the order of work and any questions to answer first. If a question is marked as blocking, ask the person you are working with before starting the tasks it affects.",
    "2. Take the first unticked item in PROGRESS.md and open its prompt under `prompts/`. Follow that prompt; it says what to read, what not to change, and how to check the result.",
    "3. Do one task at a time. Prove each defect before fixing it: a test that fails on the current code for the reason the issue gives. Verify the task as its prompt says before you tick it in PROGRESS.md. If a check fails or the code does not match the prompt, stop and report instead of guessing.",
    `4. Record each issue's result in ${RESULTS_FILE} as you finish it: ${RESULT_VALUES.map((value) => `\`${value}\``).join(", ")}, whether its test failed before the fix, the test, and the proof (the failing output, or why no test could show it).`,
    `5. Do not change anything in this folder except PROGRESS.md and ${RESULTS_FILE}.`, "",
    "The prompt folders say which kind of model each task suits:", "",
    ...(checks === 0 ? [] : [`- \`${CHECK_FIRST}\`: your strongest model, to decide whether a reported defect the audit could not settle is real, and to fix it if it is.`]),
    ...Object.values(TIERS).map(({ folder, model, why }) => `- \`${folder}\`: ${model}, for ${why}.`), "",
    `There are ${ordered.length} tasks${checks === 0 ? "" : ` and ${checks} ${checks === 1 ? "issue" : "issues"} to check`}.`, ""].join("\n");
}

interface SeverityKept { readonly candidateId: string; readonly foundAs: string; readonly loweredTo: string; readonly by: string; readonly reason: string }

function readme(plan: ExportPlan, ordered: readonly ExportTask[], runId: string, workflow: string, { unsettled, unverified, alsoFound, kept }: { readonly unsettled: readonly ExportIssue[]; readonly unverified: number; readonly alsoFound: number; readonly kept: readonly (SeverityKept & { readonly title: string })[] }): string {
  const blocking = plan.unresolvedQuestions.filter(({ blocking: isBlocking }) => isBlocking);
  // A plan written in sections carries every section's title joined into one; it reads as a summary, not a heading.
  const fixes = new Set(ordered.flatMap((task) => task.addresses.issues)).size;
  return [`# Plan · ${ordered.length} ${ordered.length === 1 ? "task" : "tasks"} for ${fixes} ${fixes === 1 ? "issue" : "issues"}`, "", plan.title.split(/;\s+/u).map((part) => `- ${part}`).join("\n"), "", `From arbitra run \`${runId}\` (${workflow}).`, "",
    "Work through the prompts in the order below. Each one is self-contained: paste it into your coding agent (Claude Code, Codex or another), or follow it yourself. The folder says which kind of model each task suits.", "",
    `Each defect is proven before it is fixed: a test that fails on the current code, then passes with the fix. Record each issue's result in \`${RESULTS_FILE}\`; arbitra reads it back and reports how many defects a failing test proved and how many were fixed.`, "",
    ...(blocking.length === 0 ? [] : ["## Answer these first", "", ...blocking.map(({ id, question }) => `- **${id}**: ${question}`), ""]),
    ...(unsettled.length === 0 ? [] : ["## Check these", "",
      `The audit could not settle ${unsettled.length === 1 ? "this issue" : `these ${unsettled.length} issues`}: the auditors disagreed, and the verifier could not decide from the code it was shown. Each prompt in \`prompts/${CHECK_FIRST}\` asks a strong model to decide whether the defect is real, by reading the code and running it where that helps, and to fix it if it is.`, "",
      ...unsettled.map((issue, index) => `${index + 1}. \`${issue.candidateId}\` ${issue.claim.title} · ${issue.severity}`), ""]),
    ...(kept.length === 0 ? [] : ["## Severity kept", "",
      `One reviewer alone lowered ${kept.length === 1 ? "this issue" : `these ${kept.length} issues`} below the plan's minimum severity, so ${kept.length === 1 ? "it was" : "they were"} verified and planned at the severity ${kept.length === 1 ? "it was" : "they were"} found with. The reviewer's reason is worth weighing when you fix ${kept.length === 1 ? "it" : "them"}.`, "",
      ...kept.map(({ candidateId, title, foundAs, loweredTo, by, reason }) => `- \`${candidateId}\` ${title}: found as ${foundAs}; ${by} proposed ${loweredTo}: ${reason.replace(/\s+/gu, " ").slice(0, 400)}`), ""]),
    ...(alsoFound === 0 ? [] : [`\`also-found.md\` lists ${alsoFound} more ${alsoFound === 1 ? "issue" : "issues"} the reviewers agreed ${alsoFound === 1 ? "is" : "are"} real but no task fixes.`, ""]),
    ...(unverified === 0 ? [] : [`${unverified} lower-severity ${unverified === 1 ? "issue was" : "issues were"} left unverified and ${unverified === 1 ? "is" : "are"} not planned; the run's issue board lists them.`, ""]),
    "## Order of work", "", ...ordered.map((task, index) => `${index + 1}. \`${task.id}\` ${task.title} · ${TIERS[task.routing.capability].folder}${task.dependencies.dependsOn.length === 0 ? "" : ` · after ${task.dependencies.dependsOn.join(", ")}`}`), "",
    "## Model tiers", "", ...Object.values(TIERS).map(({ folder, model, why }) => `- \`${folder}\`: ${model}, for ${why}.`), ""].join("\n");
}

function prompt(task: ExportTask, issues: ReadonlyMap<string, ExportIssue>, all: readonly ExportTask[]): string {
  const tier = TIERS[task.routing.capability];
  const list = (items: readonly string[]) => items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");
  const section = (tag: string, body: string) => `<${tag}>\n${body}\n</${tag}>`;
  const fixes = task.addresses.issues.map((id) => issues.get(id)).filter((issue): issue is ExportIssue => issue !== undefined)
    .map((issue) => `- ${issue.claim.title} (${issue.severity})\n  ${issue.claim.description.replace(/\s+/gu, " ").slice(0, 1_200)}`);
  const before = task.dependencies.dependsOn.map((id) => all.find((other) => other.id === id)).filter((other): other is ExportTask => other !== undefined).map((other) => `${other.id} ${other.title}`);
  const commands = task.verification.commands.map((command) => `- \`${command.command}\` should exit ${command.expectedExitCode}${command.executionPolicy === "requires_approval" ? " (ask before running it)" : ""}`);
  return [`# ${task.id} · ${task.title}`, "", `Suggested model: ${tier.model}, effort ${task.routing.effort}.${task.routing.reason.length === 0 ? "" : ` Why: ${task.routing.reason.join("; ")}`}`, "",
    "You are a careful senior engineer making one change in this repository. Read the material below before you edit anything, keep to the constraints, and stop and ask if something does not match what this prompt says.", "",
    section("goal", `${task.goal.objective}\n\nThis matters because it fixes:\n${fixes.length === 0 ? "- (see issues.md)" : fixes.join("\n")}`), "",
    ...(before.length === 0 ? [] : [section("done_before_this", list(before)), ""]),
    section("read_first", list([...new Set([...task.readFirst, ...task.scope.likelyFiles])])), "",
    section("context", list(task.context.filter((line) => !line.startsWith("resolves:")))), "",
    section("constraints", `Do not change:\n${list([...task.filesNotToTouch, ...task.outOfScope])}\n\nKeep true:\n${list(task.invariants)}`), "",
    ...(task.addresses.issues.length === 0 ? [] : [section("reproduce_first", `For ${task.addresses.issues.length === 1 ? "the issue" : "each issue"} this task fixes (${task.addresses.issues.map((id) => `\`${id}\``).join(", ")}): ${REPRODUCE_FIRST}`), ""]),
    section("steps", task.implementationGuidance.length === 0 ? "- Make the smallest change that meets the success criteria." : task.implementationGuidance.map((step, index) => `${index + 1}. ${step}`).join("\n")), "",
    section("success_criteria", list([...task.goal.doneWhen, ...task.acceptanceCriteria])), "",
    section("verify", `${list([...task.verification.preconditions, ...task.verification.checks])}${commands.length === 0 ? "" : `\n\nCommands:\n${commands.join("\n")}`}`), "",
    ...(task.rollbackPlan.length === 0 ? [] : [section("if_it_goes_wrong", list(task.rollbackPlan)), ""]),
    `When you finish, record each issue's result in ${RESULTS_FILE}, and report what you changed, how you checked it, and anything you could not do.`, ""].join("\n");
}

const isUnresolved = (issue: ExportIssue): boolean => issue.disposition === "needs_verification" || issue.disposition === "non_consensus";

/**
 * Unresolved issues of the plan's scope that no task addresses, most severe first. Without a recorded scope, those
 * verification looked at. Observed live (October 21, 2026): 3 high and 11 medium issues the verifier could not settle
 * fell out of the plan with no question or task naming them.
 */
function unsettledIssues(issues: readonly ExportIssue[], tasks: readonly ExportTask[], minimumSeverity: string | null): readonly ExportIssue[] {
  const planned = new Set(tasks.flatMap((task) => task.addresses.issues));
  const floor = minimumSeverity === null ? -1 : SEVERITIES.indexOf(minimumSeverity);
  return issues.filter((issue) => isUnresolved(issue) && !planned.has(issue.candidateId)
    && (floor < 0 ? (issue.verificationOutcome ?? null) !== null : SEVERITIES.indexOf(issue.severity) >= floor))
    .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity));
}

/** A prompt to settle one issue the audit left open: decide whether it holds, from the code and by running it, then fix it if it does. */
function checkPrompt(issue: ExportIssue): string {
  const section = (tag: string, body: string) => `<${tag}>\n${body}\n</${tag}>`;
  const views = (issue.dissent ?? []).map(({ authorId, disposition, reason }) => `- ${authorId} (${disposition.replace(/_/gu, " ")}): ${reason.replace(/\s+/gu, " ").slice(0, 1_200)}`);
  return [`# Check ${issue.candidateId} · ${issue.claim.title}`, "", `Suggested model: ${TIERS.frontier.model}, effort high. Why: the audit could not settle this by reading alone.`, "",
    "You are a careful senior engineer checking one reported defect in this repository before anyone fixes it. Several models audited the project; they disagreed about this one, and arbitra's verifier could not decide from the code it was shown. The report may be wrong, so treat it as a claim to test, not a fact.", "",
    section("claim", `${issue.claim.title} (${issue.severity})\n\n${issue.claim.description.replace(/\s+/gu, " ").slice(0, 2_000)}`), "",
    ...(views.length === 0 ? [] : [section("what_the_reviewers_said", views.join("\n")), ""]),
    section("steps", ["1. Read the code the claim names, and what it calls, until you can say whether the claim holds.",
      "2. Where reading cannot decide it, run the smallest check that can: an existing test, a short script, or the command the claim depends on. Ask before running anything that changes data or reaches the network.",
      "3. If the claim does not hold, change nothing and say why, citing the lines or the output that decide it.",
      "4. If it holds, make the smallest fix, add a test that fails without it, and run the project's checks."].join("\n")), "",
    section("success_criteria", "- A clear verdict, holds or does not hold, with the lines or output that decide it.\n- If it holds: the fix and its test, with the project's checks passing."), "",
    `When you finish, record the result in ${RESULTS_FILE} (\`no_change_needed\` when the claim does not hold), and report the verdict, what you changed, and how you checked it.`, ""].join("\n");
}

/** One entry per issue the plan fixes or asks to check, for the executor to fill in. */
function resultsTemplate(runId: string, unsettled: readonly ExportIssue[], ordered: readonly ExportTask[], issues: ReadonlyMap<string, ExportIssue>) {
  const entry = (issue: ExportIssue, task: string) => ({ issue: issue.candidateId, title: issue.claim.title, severity: issue.severity, task, result: null, failedBefore: null, test: null, proof: null });
  const planned = [...new Set(ordered.flatMap((task) => task.addresses.issues))].flatMap((id) => {
    const issue = issues.get(id); const task = ordered.find((candidate) => candidate.addresses.issues.includes(id));
    return issue === undefined || task === undefined ? [] : [entry(issue, task.id)];
  });
  return { run: runId,
    instructions: `Fill in an entry as you finish its task. result: ${RESULT_VALUES.join(", ")}. failedBefore: true when a test failed on the unchanged code for this issue's reason, false when none could be made to fail. test: the test's file and name. proof: the failing output, or why no test could show the defect.`,
    issues: [...unsettled.map((issue, index) => entry(issue, `check ${String(index + 1).padStart(2, "0")}`)), ...planned] };
}

/** Tasks in an order that puts each after the tasks it depends on; the plan's own order breaks ties. */
function topological(tasks: readonly ExportTask[]): readonly ExportTask[] {
  const done = new Set<string>(); const result: ExportTask[] = [];
  const visit = (task: ExportTask, path: Set<string>): void => {
    if (done.has(task.id) || path.has(task.id)) return;
    path.add(task.id);
    for (const id of task.dependencies.dependsOn) { const other = tasks.find((candidate) => candidate.id === id); if (other !== undefined) visit(other, path); }
    done.add(task.id); result.push(task);
  };
  for (const task of tasks) visit(task, new Set());
  return result;
}
