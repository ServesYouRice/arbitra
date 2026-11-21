import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findings, nameHash, privateNames } from "./check.mjs";

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

test("refuses a private project's name in any spelling, by its hash, and leaves other words alone", () => {
  // A made-up name stands in for the private ones, which the check holds only as hashes.
  const names = new Set([nameHash("zebracorn"), nameHash("zebracornhub")]);
  for (const text of ["zebracorn", "ZEBRACORN's plan", "on zebracorns", "/work/zebracorn/src", "x-zebracorn-token", "Zebra Corn", "zebra-corn", "zebra_corn", "ZebraCorn", "Zebra Corn Hub"]) {
    assert.ok(privateNames(text, names).length > 0, text);
  }
  assert.deepEqual(privateNames("a zebra, a corn field and a unicorn", names), []);
  assert.deepEqual(privateNames("the zebracornish word", names), []);
});

test("holds the private names as SHA-256 hashes only, and passes the descriptions that replace them", () => {
  assert.deepEqual(findings("a comments service, a desktop automation app and a social web app"), []);
  assert.equal(nameHash("a"), "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  const source = readFileSync(new URL("./check.mjs", import.meta.url), "utf8");
  const listed = /const PRIVATE_NAMES = new Set\(\[([^\]]*)\]\)/u.exec(source)?.[1] ?? "";
  const entries = listed.split(",").map((entry) => entry.trim()).filter(Boolean);
  assert.ok(entries.length >= 10);
  for (const entry of entries) assert.match(entry, /^"[0-9a-f]{64}"$/u);
});
