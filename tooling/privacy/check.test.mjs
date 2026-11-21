import { test } from "node:test";
import assert from "node:assert/strict";
import { findings, namesPattern } from "./check.mjs";

// Built at run time, so this file never holds the strings it checks for.
const at = "@";
const name = ["ali", "ce"].join("");

test("refuses a real home folder on Windows, macOS and Linux, and accepts the placeholders", () => {
  assert.deepEqual(findings(`C:\\Users\\${name}\\project`), [`home folder C:\\Users\\${name}`]);
  assert.deepEqual(findings(`C:\\\\Users\\\\${name}\\\\project`), [`home folder C:\\\\Users\\\\${name}`]);
  assert.deepEqual(findings(`c:/Users/${name}/project`), [`home folder c:/Users/${name}`]);
  assert.deepEqual(findings(`/Users/${name}/Projects/arbitra/.env`), [`home folder /Users/${name}`]);
  assert.deepEqual(findings(`/home/${name}/.cache`), [`home folder /home/${name}`]);
  assert.deepEqual(findings("C:\\Users\\me\\a /Users/me/a /home/user/.cache/agy /Users/<you>/x %LOCALAPPDATA%"), []);
});

test("refuses a real email address and accepts placeholders, noreply addresses and package versions", () => {
  assert.deepEqual(findings(`mail ${name}${at}live.com`), [`email ${name}${at}live.com`]);
  assert.deepEqual(findings(`a${at}example.test b${at}arbitra.invalid noreply${at}anthropic.com 1+x${at}users.noreply.github.com`), []);
  assert.deepEqual(findings(`audit${at}1.0.0 pnpm${at}10.24.0 git${at}github.com:owner/repo`), []);
});

test("refuses a listed private project name as a whole word, in any case, and none when none is listed", () => {
  const project = ["zor", "blax"].join("");
  const names = namesPattern(["# private projects", `  ${project}  `, "", "a.b"]);
  assert.deepEqual(findings(`audited ${project}, then ${project.toUpperCase()}'s plan`, names), [`private project name ${project}`, `private project name ${project.toUpperCase()}`]);
  assert.deepEqual(findings(`/work/${project}/src and ${project}-app`, names), [`private project name ${project}`, `private project name ${project}`]);
  assert.deepEqual(findings(`${project}s un${project} ${project}_x ${project}2 axb`, names), []);
  assert.deepEqual(findings(`audited ${project}`), []);
  assert.equal(namesPattern(["# none", " "]), null);
});
