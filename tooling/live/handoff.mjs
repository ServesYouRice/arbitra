#!/usr/bin/env node
// Hand a live run's exported plan to a fresh coding agent, one task at a time (completion plan P03).
//   node tooling/live/handoff.mjs <work-name> <run-id> [--model <claude model>]
//
// The run is exported through the public CLI. Running this script is the operator's grant, and it
// prints what it grants: each task's proposed files (scope.likelyFiles, less filesNotToTouch) as its
// write scope, and its verification commands. Each task goes to a new Claude Code process (the
// subscription login on this host) whose working directory is a clean fixture checkout with the
// rendered handoff in ./implementation, the layout the handoff's own paths assume. No run state,
// journal or trace is reachable from it, and the host's settings,
// memory, skills, plugins, hooks and MCP servers are switched off. After each task the
// script itself runs the approved verification commands, then checks that the handoff contract is
// unchanged and that every repository edit stays inside that task's grant.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [name, runId, ...options] = process.argv.slice(2);
if (name === undefined || runId === undefined) { process.stderr.write("usage: handoff.mjs <work-name> <run-id> [--model <model>]\n"); process.exit(2); }
const model = options[0] === "--model" && options[1] !== undefined ? options[1] : "claude-sonnet-5";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = join(root, ".runs/live/work", name);
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { renderImplementation, writeImplementation } = await load("packages/core/dist/src/render/index.js");
const { resolveCliExecutable } = await load("packages/providers/dist/src/transports/cli/discovery.js");
const { requireCliTransportSupport } = await load("packages/providers/dist/src/transports/cli/support.js");

const exported = JSON.parse(execFileSync(process.execPath, [join(root, "apps/cli/dist/src/bin.js"), "export", runId, "--json"], { cwd: join(work, "repo"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
const implementation = exported.result?.artifacts?.implementation;
if (implementation === undefined) throw new Error("HANDOFF_ABSENT: the run published no implementation handoff");
const manifest = JSON.parse(JSON.parse(implementation.content)["manifest.json"]);
const order = topological(manifest.tasks);

const claude = await resolveCliExecutable(requireCliTransportSupport("claude-code-cli"), { platform: process.platform, lookup: (key) => process.env[key], nodeExecutable: process.execPath });
if (!claude.found) throw new Error(`CLAUDE_CODE_NOT_FOUND: ${claude.detail}`);

const sandbox = mkdtempSync(join(tmpdir(), "arbitra-live-handoff-"));
const repository = join(sandbox, "checkout"); const handoff = join(repository, "implementation");
cpSync(join(root, "tooling/live/fixture-repo"), repository, { recursive: true });
const git = (...args) => execFileSync("git", ["-c", "user.email=live@arbitra.invalid", "-c", "user.name=live", ...args], { cwd: repository, encoding: "utf8" });
git("init", "-q"); git("add", "-A"); git("commit", "-qm", "fixture");
const evidence = join(work, "handoff"); rmSync(evidence, { recursive: true, force: true }); mkdirSync(evidence, { recursive: true });
const results = [];
let progress = "";
try {
  for (const task of order) {
    const excluded = task.filesNotToTouch ?? [];
    const write = task.scope.likelyFiles.filter((path) => !excluded.includes(path));
    const commands = task.verification.commands.map(({ command, expectedExitCode }) => ({ command, expectedExitCode }));
    process.stdout.write(`${task.id}: granting write ${JSON.stringify(write)} and approving ${JSON.stringify(commands.map(({ command }) => command))}\n`);
    // The rendered file set is the same for every selected task, so rendering over it keeps execution/ evidence.
    const tree = renderImplementation(manifest, { selectedTaskId: task.id, adapters: ["claude"], effectiveWriteScopes: { [task.id]: write } });
    writeImplementation({ ...tree, "progress.jsonl": progress }, handoff);
    const contract = hashes(handoff, (path) => path !== "progress.jsonl" && !path.startsWith("execution/"));
    const before = hashes(repository, source);
    const prompt = [
      `You are a fresh coding agent in this checkout. Execute ${task.id} from the handoff in ./implementation.`,
      "Start with implementation/AGENTS.md and implementation/CLAUDE.md, then the selected task contract. Paths in the handoff are relative to this checkout.",
      `The operator has approved these verification commands, to run from this checkout: ${commands.map(({ command }) => command).join(", ")}.`,
      "Do not run any other command. Do not edit the manifest, task contracts, context or validation documents.",
      `Append your lifecycle status to implementation/progress.jsonl as the progress schema describes. Stop when ${task.id} is done or blocked.`,
    ].join("\n");
    const allowed = ["Read", "Glob", "Grep", "Edit", "Write", ...commands.map(({ command }) => `Bash(${command})`)];
    const started = Date.now();
    const agent = spawnSync(claude.executable.command, [...claude.executable.prefixArguments, "-p", "--model", model, "--output-format", "json",
      "--permission-mode", "acceptEdits", "--allowedTools", allowed.join(","), "--disallowedTools", "WebFetch,WebSearch,Task",
      "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--setting-sources", "", "--safe-mode", "--no-session-persistence"], {
      cwd: repository, input: prompt, encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024, env: releaseEnvironment(),
    });
    const verification = commands.map(({ command, expectedExitCode }) => {
      const result = spawnSync(command, { cwd: repository, shell: true, encoding: "utf8", timeout: 5 * 60_000, env: releaseEnvironment() });
      return { command, expectedExitCode, exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4_000) };
    });
    const after = hashes(repository, source);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort();
    const contractAfter = hashes(handoff, (path) => path !== "progress.jsonl" && !path.startsWith("execution/"));
    progress = readFileSync(join(handoff, "progress.jsonl"), "utf8");
    const reply = parseReply(agent.stdout);
    const result = {
      taskId: task.id, grantedWrite: write, changed, outsideGrant: changed.filter((path) => !write.includes(path)),
      contractPreserved: JSON.stringify(contract) === JSON.stringify(contractAfter),
      agent: { exitCode: agent.status, signal: agent.signal, durationMs: Date.now() - started, turns: reply?.num_turns ?? null, usage: reply?.usage ?? null, isError: reply?.is_error ?? null },
      verification: verification.map(({ command, expectedExitCode, exitCode }) => ({ command, expectedExitCode, exitCode })),
      progress: progress.split("\n").filter((line) => line.trim() !== ""),
    };
    result.accepted = result.contractPreserved && result.outsideGrant.length === 0 && verification.every(({ exitCode, expectedExitCode }) => exitCode === expectedExitCode) && agent.status === 0;
    results.push(result);
    writeFileSync(join(evidence, `${task.id}.transcript.txt`), [`agent exit: ${agent.status}`, typeof reply?.result === "string" ? reply.result : agent.stdout, agent.stderr, ...verification.map(({ command, exitCode, output }) => `$ ${command} -> ${exitCode}\n${output}`)].join("\n\n"));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.accepted) break;
  }
  git("add", "-A", "--intent-to-add", "--", ".", ":!implementation"); writeFileSync(join(evidence, "changes.diff"), git("diff", "--", ".", ":!implementation"));
  cpSync(handoff, join(evidence, "implementation"), { recursive: true });
} finally { rmSync(sandbox, { recursive: true, force: true }); }
const summary = { runId, model, executor: `${claude.executable.path} (${claude.executable.source})`, accepted: results.length === order.length && results.every(({ accepted }) => accepted), tasks: results };
writeFileSync(join(evidence, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ accepted: summary.accepted, evidence: relative(root, evidence) })}\n`);
process.exitCode = summary.accepted ? 0 : 1;

function topological(tasks) {
  const done = new Set(); const ordered = [];
  while (ordered.length < tasks.length) {
    const ready = tasks.filter(({ id, dependencies }) => !done.has(id) && dependencies.dependsOn.every((dependency) => done.has(dependency))).sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error("HANDOFF_TASK_CYCLE");
    for (const task of ready) { done.add(task.id); ordered.push(task); }
  }
  return ordered;
}
/** Repository source: everything but version control and the handoff itself. */
function source(path) { return !path.startsWith(".git/") && !path.startsWith("implementation/"); }
function hashes(directory, include) {
  const result = {};
  const walk = (current) => { for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name); const relativePath = relative(directory, path).replaceAll("\\", "/");
    if (entry.isDirectory()) { if (relativePath !== ".git" && include(`${relativePath}/`)) walk(path); } else if (entry.isFile() && include(relativePath)) result[relativePath] = createHash("sha256").update(readFileSync(path)).digest("hex");
  } };
  if (existsSync(directory)) walk(directory);
  return result;
}
function parseReply(stdout) { try { return JSON.parse(stdout); } catch { return null; } }
function releaseEnvironment() {
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.includes(key)));
}
