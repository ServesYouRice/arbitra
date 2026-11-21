import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_DOWNLOADS, NODE_VERSION, nodeBinary, sha256, verified } from "./node-download.mjs";
import { publishCommands, releaseFiles, releaseVersion } from "./release.mjs";

const folder = () => mkdtempSync(join(tmpdir(), "arbitra-package-"));

test("pins a SHA-256 for each platform's Node download of this exact version", () => {
  for (const platform of ["win-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) {
    assert.match(NODE_DOWNLOADS[platform].sha256, /^[0-9a-f]{64}$/u, platform);
    assert.ok(NODE_DOWNLOADS[platform].file === "win-x64/node.exe" || NODE_DOWNLOADS[platform].file.startsWith(`node-v${NODE_VERSION}-${platform}.`), platform);
  }
});

test("a file whose SHA-256 is not the pinned one fails, and one that matches passes unchanged", () => {
  const bytes = Buffer.from("node");
  assert.equal(verified(bytes, sha256(bytes), "x"), bytes);
  assert.throws(() => verified(bytes, "0".repeat(64), "Node download"), /Node download: SHA-256 [0-9a-f]{64} is not the pinned 0{64}/u);
});

test("refuses a changed download and keeps nothing of it", async () => {
  const cache = folder();
  try {
    let asked;
    await assert.rejects(nodeBinary("win-x64", cache, { fetchBytes: async (url) => { asked = url; return Buffer.from("not the published node.exe"); } }), /is not the pinned/u);
    assert.equal(asked, `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`);
    assert.equal(existsSync(join(cache, `v${NODE_VERSION}-win-x64-node.exe`)), false);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

test("refuses a cached download that changed after it was checked", async () => {
  const cache = folder();
  try {
    writeFileSync(join(cache, `v${NODE_VERSION}-win-x64-node.exe`), "changed on disk");
    await assert.rejects(nodeBinary("win-x64", cache, { fetchBytes: async () => assert.fail("a cached file is not downloaded again") }), /cached at .*delete it to download again/u);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

test("refuses a platform with no pinned download", async () => {
  await assert.rejects(nodeBinary("linux-arm64", tmpdir()), /no pinned Node download for linux-arm64/u);
});

test("the release takes one version, names the asset as the releases do and writes a checkable SHA-256 file", () => {
  assert.equal(releaseVersion(["v0.5.0"]), "0.5.0");
  assert.equal(releaseVersion(["0.5.0-rc.1"]), "0.5.0-rc.1");
  assert.throws(() => releaseVersion([]), /usage: pnpm release <version>/u);
  assert.throws(() => releaseVersion(["latest"]), /not a version/u);
  const files = releaseFiles("0.5.0", Buffer.from("exe"));
  assert.deepEqual(files, { asset: "arbitra-0.5.0-windows.exe", checksum: "arbitra-0.5.0-windows.exe.sha256", checksumText: `${sha256(Buffer.from("exe"))}  arbitra-0.5.0-windows.exe\n` });
});

test("the release prints the tag and upload commands for the commit that passed, and runs none of them", () => {
  assert.deepEqual(publishCommands("0.5.0", "abc1234", ["dist-release/v0.5.0/a.exe", "dist-release/v0.5.0/a.exe.sha256"]), [
    "git tag -a v0.5.0 abc1234 -m \"arbitra 0.5.0\"",
    "git push origin v0.5.0",
    "gh release create v0.5.0 --verify-tag --title \"arbitra 0.5.0\" dist-release/v0.5.0/a.exe dist-release/v0.5.0/a.exe.sha256",
  ]);
  const source = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /run\("git", \[|"tag", "-a"|"push"|run\("gh"/u);
});
