// Builds the single-file app: `node tooling/package/build.mjs <win-x64|darwin-arm64|darwin-x64> [version]` after
// `pnpm build`. It bundles the server into one CommonJS file, packs it with the web app and protocol assets into one
// asset, and injects that with tooling/package/bootstrap.cjs into an official Node binary (Node's single executable
// applications). Output: dist-package/<target>/arbitra(.exe). Runs on this machine only; no hosted CI. The Node
// download is checked against its pinned SHA-256 (node-download.mjs), and postject is the locked dev dependency.
// `pnpm release` (tooling/package/release.mjs) runs the full check first and writes the release files.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { NODE_DOWNLOADS, NODE_VERSION, nodeBinary } from "./node-download.mjs";

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

// 3. The Node binary for the target, downloaded once and checked against its pinned hash on every build.
const binary = join(work, `node-${NODE_VERSION}-${target}${target.startsWith("win") ? ".exe" : ""}`);
writeFileSync(binary, await nodeBinary(target, cache, { say }), { mode: 0o755 });

// 4. The blob, injected into a copy of the binary.
const main = join(work, "bootstrap.cjs");
writeFileSync(main, readFileSync(join(root, "tooling", "package", "bootstrap.cjs"), "utf8").replace("__ARBITRA_VERSION__", version).replace("__ARBITRA_CONTENT__", createHash("sha256").update(readFileSync(join(work, "app.bin"))).digest("hex").slice(0, 8)));
writeFileSync(join(work, "sea-config.json"), JSON.stringify({ main, output: join(work, "sea.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets: { "app.bin": join(work, "app.bin") } }));
say("making the blob");
// The blob holds no code cache or snapshot, so any Node of the same version makes it: a Mac build made on Windows
// uses the Windows binary, which can run here.
const host = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
if (NODE_DOWNLOADS[host] === undefined) throw new Error(`no pinned Node ${NODE_VERSION} for this machine (${host}) to make the blob`);
const maker = host === target ? binary : join(work, `node-${NODE_VERSION}-${host}${process.platform === "win32" ? ".exe" : ""}`);
if (host !== target) writeFileSync(maker, await nodeBinary(host, cache, { say }), { mode: 0o755 });
execFileSync(maker, ["--experimental-sea-config", join(work, "sea-config.json")], { stdio: "inherit" });
const output = join(work, target.startsWith("win") ? "arbitra.exe" : "arbitra");
copyFileSync(binary, output);
say("injecting");
const postject = [createRequire(import.meta.url).resolve("postject/dist/cli.js"), output, "NODE_SEA_BLOB", join(work, "sea.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(target.startsWith("darwin") ? ["--macho-segment-name", "NODE_SEA"] : [])];
execFileSync(process.execPath, postject, { stdio: "inherit" });
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
