// The official Node binary the single-file app is built on, checked against the SHA-256 that nodejs.org publishes
// for this exact version (SHASUMS256.txt, whose signature by a Node releaser was checked when the hashes were pinned).
// A download that does not match fails the build, and so does a cached one: a file changed after the first build is
// caught as well. To move to another Node version, change NODE_VERSION and every hash below in the same commit, from
// https://nodejs.org/dist/v<version>/SHASUMS256.txt after `gpg --verify SHASUMS256.txt.sig SHASUMS256.txt`.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const NODE_VERSION = "22.23.2";

/**
 * Each platform's published file and its SHA-256. linux-x64 is not a target: its Node only makes the blob when the
 * package is built on Linux (the blob holds no code, so any Node of the same version makes it).
 */
export const NODE_DOWNLOADS = {
  "win-x64": { file: "win-x64/node.exe", sha256: "0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4" },
  "darwin-arm64": { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6" },
  "darwin-x64": { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026" },
  "linux-x64": { file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a" },
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The bytes, unchanged, when their SHA-256 is `expected`; otherwise an error that names both. */
export function verified(bytes, expected, label) {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label}: SHA-256 ${actual} is not the pinned ${expected}; refusing to build on it`);
  return bytes;
}

/**
 * The Node executable for a platform, from the cache folder or downloaded into it, verified each time against the
 * pinned hash before it is used. `fetchBytes` is the download (a parameter so tests make no network calls).
 */
export async function nodeBinary(platform, cache, { say = () => {}, fetchBytes = download } = {}) {
  const entry = NODE_DOWNLOADS[platform];
  if (entry === undefined) throw new Error(`no pinned Node download for ${platform}`);
  const cached = join(cache, `v${NODE_VERSION}-${entry.file.replaceAll("/", "-")}`);
  const label = `Node ${NODE_VERSION} ${entry.file}`;
  let bytes;
  if (existsSync(cached)) bytes = verified(readFileSync(cached), entry.sha256, `${label} (cached at ${cached}; delete it to download again)`);
  else {
    say(`downloading Node ${NODE_VERSION} for ${platform}`);
    bytes = verified(await fetchBytes(`https://nodejs.org/dist/v${NODE_VERSION}/${entry.file}`), entry.sha256, label);
    writeFileSync(cached, bytes);
  }
  return entry.file.endsWith(".tar.gz") ? tarEntry(gunzipSync(bytes), `node-v${NODE_VERSION}-${platform}/bin/node`) : bytes;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** One file's bytes from an uncompressed tar. */
export function tarEntry(tar, wanted) {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/su, "");
    const prefix = tar.subarray(offset + 345, offset + 500).toString("utf8").replace(/\0.*$/su, "");
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString("utf8").replace(/\0.*$/su, "").trim() || "0", 8);
    if (name === "") break;
    if ((prefix === "" ? name : `${prefix}/${name}`) === wanted) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not found in the Node archive`);
}
