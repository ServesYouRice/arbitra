#!/usr/bin/env node
// Refuses personal data in what the repository publishes: home-folder paths and email addresses other than
// placeholders, a commit identity that is not a noreply address, and the names of the maintainer's private projects.
// The repository is public, and a rewritten history is the only way to take such data back out.
//
// The private names are listed in the clone's `.git/info/private-names` (one a line, `#` starts a comment), which Git
// never publishes; without that file, as in a fresh clone, there are none to look for. A name matches as a whole
// word, in any case, in a file's text and in its path.
//
//   node tooling/privacy/check.mjs              every tracked file (part of `pnpm run ci`)
//   node tooling/privacy/check.mjs --staged     the staged files and the commit identity (pre-commit hook)
//   node tooling/privacy/check.mjs --message F  a commit message (commit-msg hook)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const git = (...args) => execFileSync("git", args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// Placeholder homes used by tests and docs: /Users/me, C:\Users\me, /home/user, and <name>-style templates.
const HOME_PATTERNS = [
  /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?!(?:me|you|user|Public|Default)\b)(?!<)[\w.-]+/giu,
  /(?<![\w.:-])\/Users\/(?!(?:me|you|user|Shared)\b)(?!<)[\w.-]+/gu,
  /(?<![\w.-])\/home\/(?!(?:user|me|node|runner)\b)(?!<)[\w.-]+/gu,
];
// A domain ends in letters, so package specifiers such as audit@1.0.0 are not addresses.
const EMAIL = /[\w.%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/gu;
const PLACEHOLDER_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net|test)|example|invalid|test|localhost|users\.noreply\.github\.com)$/iu;
const isPlaceholderEmail = (email) => {
  const [local, domain] = email.split("@");
  return PLACEHOLDER_DOMAIN.test(domain) || /^(?:noreply|no-reply|git)$/iu.test(local);
};

const escaped = (word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** A pattern matching any of `lines` (blank lines and `#` comments skipped) as a whole word, in any case; null for none. */
export function namesPattern(lines) {
  const names = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  return names.length === 0 ? null : new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map(escaped).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/** The private names this clone lists in `.git/info/private-names`, as a pattern; null when it lists none. */
function privateNames() {
  try {
    const file = join(git("rev-parse", "--git-common-dir").toString("utf8").trim(), "info", "private-names");
    return existsSync(file) ? namesPattern(readFileSync(file, "utf8").split(/\r?\n/u)) : null;
  } catch { return null; }
}

export function findings(text, names = null) {
  const hits = [];
  for (const pattern of HOME_PATTERNS) for (const match of text.matchAll(pattern)) hits.push(`home folder ${match[0]}`);
  for (const match of text.matchAll(EMAIL)) if (!isPlaceholderEmail(match[0])) hits.push(`email ${match[0]}`);
  if (names !== null) for (const match of text.matchAll(names)) hits.push(`private project name ${match[0]}`);
  return hits;
}

function scan(entries) {
  const names = privateNames();
  const problems = [];
  for (const { path, content } of entries) {
    if (names !== null) for (const match of path.matchAll(names)) problems.push(`${path}: private project name ${match[0]} in the path`);
    if (content.includes(0)) continue; // binary
    const text = content.toString("utf8");
    text.split("\n").forEach((line, index) => { for (const hit of findings(line, names)) problems.push(`${path}:${index + 1}: ${hit}`); });
  }
  return problems;
}

/** The tracked files; outside a Git checkout (a downloaded zip, a container copy), every file but build output. */
function publishedPaths() {
  try { return git("ls-files", "-z").toString("utf8").split("\0").filter(Boolean); }
  catch {
    const skipped = new Set([".git", "node_modules", "dist", ".runs", ".arbitra", ".arbitra-runtime", "coverage", ".vite", "test-results", "playwright-report"]);
    const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) return skipped.has(entry.name) ? [] : walk(path);
      return entry.isFile() ? [path] : [];
    });
    return walk(".");
  }
}

function identityProblems() {
  return ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].flatMap((name) => {
    const email = /<([^>]*)>/u.exec(git("var", name).toString("utf8"))?.[1] ?? "";
    return isPlaceholderEmail(email) ? [] : [`${name === "GIT_AUTHOR_IDENT" ? "author" : "committer"} email ${email} is not a noreply address: git config user.email <id>+<login>@users.noreply.github.com`];
  });
}

function main(argv) {
  let problems;
  if (argv[0] === "--message") {
    problems = scan([{ path: "commit message", content: readFileSync(argv[1]) }]);
  } else if (argv[0] === "--staged") {
    const paths = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").toString("utf8").split("\0").filter(Boolean);
    problems = [...identityProblems(), ...scan(paths.map((path) => ({ path, content: git("show", `:${path}`) })))];
  } else {
    problems = scan(publishedPaths().map((path) => ({ path, content: readFileSync(path) })));
  }
  if (problems.length === 0) return 0;
  console.error(`Personal data the public repository must not carry (tooling/privacy/check.mjs):\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
