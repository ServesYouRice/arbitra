// Builds the single-file app: `node tooling/package/build.mjs <win-x64|darwin-arm64|darwin-x64> [version]` after
// `pnpm build`. It bundles the server into one CommonJS file, packs it with the web app and protocol assets into one
// asset, and injects that with tooling/package/bootstrap.cjs into an official Node binary (Node's single executable
// applications). Output: dist-package/<target>/arbitra(.exe). Runs on this machine only; no hosted CI.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const NODE_VERSION = "22.23.2";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [target = "win-x64", requested] = process.argv.slice(2);
if (!["win-x64", "darwin-arm64", "darwin-x64"].includes(target)) throw new Error(`unknown target ${target}`);
const version = requested ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const work = join(root, "dist-package", target);
const cache = join(root, "dist-package", ".cache");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true }); mkdirSync(cache, { recursive: true });
const say = (text) => process.stdout.write(`package: ${text}\n`);

// 1. The server and every workspace package it imports, as one CommonJS file. import.meta.url has no meaning in it;
// the paths it located are named in the environment by the bootstrap instead.
say("bundling the server");
await build({
  entryPoints: [join(root, "apps", "server", "dist", "src", "server-main.js")], outfile: join(work, "app", "server.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "warning", legalComments: "none",
  define: { "import.meta.url": "__arbitraModuleUrl" }, banner: { js: "const __arbitraModuleUrl = require(\"node:url\").pathToFileURL(__filename).href;" },
});

// 2. One asset: a 4-byte index length, the JSON index, then the files (see bootstrap.cjs).
const files = [];
const add = (from, to) => {
  if (statSync(from).isDirectory()) { for (const name of readdirSync(from)) add(join(from, name), `${to}/${name}`); return; }
  files.push({ path: to, data: readFileSync(from) });
};
add(join(work, "app", "server.cjs"), "server.cjs");
add(join(root, "apps", "web", "dist"), "web");
add(join(root, "packages", "protocols", "assets"), "protocols");
const index = Buffer.from(JSON.stringify(files.map(({ path, data }) => ({ path, size: data.length }))));
const header = Buffer.alloc(4); header.writeUInt32LE(index.length, 0);
writeFileSync(join(work, "app.bin"), Buffer.concat([header, index, ...files.map(({ data }) => data)]));
say(`${files.length} files packed`);

// 3. The Node binary for the target, downloaded once.
const binary = join(cache, `node-${NODE_VERSION}-${target}${target.startsWith("win") ? ".exe" : ""}`);
if (!existsSync(binary)) {
  say(`downloading Node ${NODE_VERSION} for ${target}`);
  if (target.startsWith("win")) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`);
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    writeFileSync(binary, Buffer.from(await response.arrayBuffer()));
  } else {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${target}.tar.gz`);
    if (!response.ok) throw new Error(`download failed: ${response.status}`);
    const tar = join(cache, `node-${NODE_VERSION}-${target}.tar`);
    await pipeline(response.body, createGunzip(), createWriteStream(tar));
    writeFileSync(binary, tarEntry(readFileSync(tar), `node-v${NODE_VERSION}-${target}/bin/node`));
  }
}

// 4. The blob, injected into a copy of the binary.
const main = join(work, "bootstrap.cjs");
writeFileSync(main, readFileSync(join(root, "tooling", "package", "bootstrap.cjs"), "utf8").replace("__ARBITRA_VERSION__", version).replace("__ARBITRA_CONTENT__", createHash("sha256").update(readFileSync(join(work, "app.bin"))).digest("hex").slice(0, 8)));
writeFileSync(join(work, "sea-config.json"), JSON.stringify({ main, output: join(work, "sea.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets: { "app.bin": join(work, "app.bin") } }));
say("making the blob");
// The blob holds no code cache or snapshot, so any Node of the same version makes it: a Mac build made on Windows
// uses the Windows binary, which can run here.
const host = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const maker = host === target ? binary : join(cache, `node-${NODE_VERSION}-${host}${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(maker)) throw new Error(`build ${host} first: its Node ${NODE_VERSION} makes the blob`);
execFileSync(maker, ["--experimental-sea-config", join(work, "sea-config.json")], { stdio: "inherit" });
const output = join(work, target.startsWith("win") ? "arbitra.exe" : "arbitra");
copyFileSync(binary, output);
say("injecting");
const postject = ["-y", "postject@1.0.0-alpha.6", output, "NODE_SEA_BLOB", join(work, "sea.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(target.startsWith("darwin") ? ["--macho-segment-name", "NODE_SEA"] : [])];
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", postject, { stdio: "inherit", shell: process.platform === "win32" });
say(`${relative(root, output)} · ${(statSync(output).size / 1e6).toFixed(0)} MB`);

// 5. On macOS the binary goes into arbitra.app, whose launcher opens it in a Terminal window: the window shows what
// arbitra is doing, and closing it stops arbitra. tooling/package/make-dmg.sh signs it and makes the .dmg on a Mac.
if (target.startsWith("darwin")) {
  const contents = join(work, "arbitra.app", "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true }); mkdirSync(join(contents, "Resources"), { recursive: true });
  copyFileSync(output, join(contents, "Resources", "arbitra"));
  writeFileSync(join(contents, "MacOS", "arbitra-launcher"), "#!/bin/sh\nexec open -a Terminal \"$(cd \"$(dirname \"$0\")/../Resources\" && pwd)/arbitra\"\n");
  writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>arbitra</string>
  <key>CFBundleDisplayName</key><string>arbitra</string>
  <key>CFBundleIdentifier</key><string>com.servesyourice.arbitra</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>arbitra-launcher</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`);
  say(`${relative(root, join(work, "arbitra.app"))}: finish it on a Mac with tooling/package/make-dmg.sh`);
}

/** One file's bytes from an uncompressed tar. */
function tarEntry(tar, wanted) {
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
