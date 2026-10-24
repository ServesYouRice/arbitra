import { test } from "node:test";
import assert from "node:assert/strict";
import { findings } from "./check.mjs";

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
