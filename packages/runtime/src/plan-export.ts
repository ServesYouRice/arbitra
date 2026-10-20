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
interface ExportIssue { readonly candidateId: string; readonly severity: string; readonly disposition: string; readonly claim: { readonly title: string; readonly description: string } }

const TIERS = {
  frontier: { folder: "1-strong-model", model: "your strongest model (such as Claude Opus) at high effort", why: "reasoning across files, or a fix that is easy to get subtly wrong" },
  balanced: { folder: "2-balanced-model", model: "a balanced model (such as Claude Sonnet)", why: "a contained change with a clear target" },
  fast: { folder: "3-fast-model", model: "a fast, inexpensive model (such as Claude Haiku)", why: "a small, mechanical change" },
} as const;

/**
 * Writes a run's plan into its repository as prompts a person or a coding agent can use directly, in
 * `.arbitra/plans/<date>-<run>/`: a README with the order of work, one prompt per task grouped by the model tier the
 * planner chose for it, and the issues they fix. Each prompt follows Anthropic's prompting guidance: a role, the
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
  const stamp = new Date().toISOString().slice(0, 10);
  const directory = join(overview.repository, ".arbitra", "plans", `${stamp}-${runId.replace(/^run-/u, "").slice(0, 8)}`);
  const files = new Map<string, string>();
  ordered.forEach((task, index) => files.set(join("prompts", TIERS[task.routing.capability].folder, `${String(index + 1).padStart(2, "0")}-${task.id}.md`), prompt(task, issues, plan.tasks)));
  files.set("README.md", readme(plan, ordered, runId, overview.workflowId ?? "unknown"));
  files.set("issues.md", ["# Issues this plan fixes", "", ...[...new Set(ordered.flatMap((task) => task.addresses.issues))].map((id) => issues.get(id)).filter((issue): issue is ExportIssue => issue !== undefined)
    .map((issue) => `## ${issue.claim.title}\n\n${issue.severity} · ${issue.disposition} · ${issue.candidateId}\n\n${issue.claim.description}\n`)].join("\n"));
  await mkdir(directory, { recursive: true });
  for (const [path, content] of files) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content, { encoding: "utf8", flag: "wx" });
  }
  return { directory, files: [...files.keys()].map((path) => relative(overview.repository ?? "", join(directory, path))) };
}

function readme(plan: ExportPlan, ordered: readonly ExportTask[], runId: string, workflow: string): string {
  const blocking = plan.unresolvedQuestions.filter(({ blocking: isBlocking }) => isBlocking);
  return [`# ${plan.title}`, "", `From arbitra run \`${runId}\` (${workflow}).`, "",
    "Work through the prompts in the order below. Each one is self-contained: paste it into your coding agent (Claude Code, Codex or another), or follow it yourself. The folder says which kind of model each task suits.", "",
    ...(blocking.length === 0 ? [] : ["## Answer these first", "", ...blocking.map(({ id, question }) => `- **${id}**: ${question}`), ""]),
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
    section("steps", task.implementationGuidance.length === 0 ? "- Make the smallest change that meets the success criteria." : task.implementationGuidance.map((step, index) => `${index + 1}. ${step}`).join("\n")), "",
    section("success_criteria", list([...task.goal.doneWhen, ...task.acceptanceCriteria])), "",
    section("verify", `${list([...task.verification.preconditions, ...task.verification.checks])}${commands.length === 0 ? "" : `\n\nCommands:\n${commands.join("\n")}`}`), "",
    ...(task.rollbackPlan.length === 0 ? [] : [section("if_it_goes_wrong", list(task.rollbackPlan)), ""]),
    "When you finish, report what you changed, how you checked it, and anything you could not do.", ""].join("\n");
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
