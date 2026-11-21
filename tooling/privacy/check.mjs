#!/usr/bin/env node
// Refuses personal data in what the repository publishes: home-folder paths and email addresses other than
// placeholders, the names of the owner's private projects (AGENTS.md: describe them instead, "a comments service"),
// and a commit identity that is not a noreply address. The repository is public, and a rewritten
// history is the only way to take such data back out.
//
//   node tooling/privacy/check.mjs              every tracked file (part of `pnpm run ci`)
//   node tooling/privacy/check.mjs --staged     the staged files and the commit identity (pre-commit hook)
//   node tooling/privacy/check.mjs --message F  a commit message (commit-msg hook)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

// The owner's private projects, each name and spelling (the repo name, the product name, a misspelling seen) lowercased
// with its spaces, hyphens, underscores and apostrophes left out. Only their SHA-256 is kept, so that this file does not
// name them either. Add a project by its hash: printf %s name | sha256sum.
const PRIVATE_NAMES = new Set([
  "1540e8a27a01a852a09db8586ce9f4479371f3e3fe5fde27c7cc17f8910cdb48",
  "24108851ecaeef7942b447672ca222132cd0ae9c66863dc44c303c9220cc0b13",
  "2767fb4fff53715630dc2e3728f9fb924abf499f6de38280be5f48560360291c",
  "339b54e730d0f93dadaa0c5382493d208a327ef6fca9f6766627c049b10f33ca",
  "371854646b0a79b29a21fe81858cb3b4e8113ed42313073ca5e5dbc90451d8d9",
  "6e1f3da6cf8847b5c2ced23d0fa63272e6cd630dabe13b73f1d2666b0cb1444d",
  "99a8a5361e067d9ee47e58928a90f93a430a1d09ef35133cd9d07b5ca35bddd8",
  "9b1b21487684daa757cf7baf0452fe745da1c1b14259bcdf1093bfac974bbf44",
  "b8cd2b6d371e3f3547edd6162a29c1d95e2bdd364e98a8f143ad38110bc2aedc",
  "db4d5256d2971246b5cad83f09b9034c554fce466c48f9a3033264028c9f4a1e",
  "e285cdd85064e369f2a8abef7052b621d9e596b3a29a8aadba8070de08c566c0",
  "f0ab3e9d8c1954c6429e096cd1e77432488818ddae3ee6061818201260b0b0de",
]);
// Up to three words in a row are joined, so a name written as two or three words ("x y", "x-y", "x's y", "xY") is found.
const WORDS_JOINED = 3;
export const nameHash = (text) => createHash("sha256").update(text).digest("hex");

/** The private names in a line, by `names` (hashes); a word is a run of letters and digits, split at camelCase too. */
export function privateNames(text, names = PRIVATE_NAMES) {
  const words = text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const hits = [];
  for (let start = 0; start < words.length; start += 1) {
    let joined = "";
    for (let end = start; end < Math.min(words.length, start + WORDS_JOINED); end += 1) {
      joined += words[end];
      // A trailing "s" may be a plural or a possessive written without its apostrophe.
      if (joined.length >= 4 && (names.has(nameHash(joined)) || (joined.endsWith("s") && names.has(nameHash(joined.slice(0, -1)))))) {
        hits.push(words.slice(start, end + 1).join(" "));
      }
    }
  }
  return hits;
}

export function findings(text) {
  const hits = [];
  for (const pattern of HOME_PATTERNS) for (const match of text.matchAll(pattern)) hits.push(`home folder ${match[0]}`);
  for (const match of text.matchAll(EMAIL)) if (!isPlaceholderEmail(match[0])) hits.push(`email ${match[0]}`);
  for (const name of privateNames(text)) hits.push(`private project name "${name}": describe the project instead`);
  return hits;
}

function scan(entries) {
  const problems = [];
  for (const { path, content } of entries) {
    if (content.includes(0)) continue; // binary
    const text = content.toString("utf8");
    text.split("\n").forEach((line, index) => { for (const hit of findings(line)) problems.push(`${path}:${index + 1}: ${hit}`); });
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
