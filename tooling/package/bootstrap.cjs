// The single-file app's entry: Node runs this inside arbitra.exe (or the macOS binary). On first start of a version it
// unpacks the bundled server, web app and protocol assets into the user's application-data folder, then starts the
// server there and opens the browser. Runs are kept beside it, not in the download folder. Built by build.mjs.
"use strict";
const { getAsset } = require("node:sea");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

const VERSION = "__ARBITRA_VERSION__";
// The content of this build: a rebuild of the same version unpacks afresh.
const CONTENT = "__ARBITRA_CONTENT__";
const say = (text) => process.stdout.write(`arbitra: ${text}\n`);

function dataRoot() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "arbitra");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "arbitra");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "arbitra");
}

/** The asset is a 4-byte index length, a JSON index of { path, size }, then the files one after another. */
function unpack(target) {
  const bytes = Buffer.from(getAsset("app.bin"));
  const indexLength = bytes.readUInt32LE(0);
  const index = JSON.parse(bytes.subarray(4, 4 + indexLength).toString("utf8"));
  let offset = 4 + indexLength;
  for (const { path, size } of index) {
    const file = join(target, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes.subarray(offset, offset + size));
    offset += size;
  }
}

function nodeOnPath() {
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : ":")) {
    for (const name of names) if (directory !== "" && existsSync(join(directory, name))) return join(directory, name);
  }
  return null;
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { say(`open ${url} in your browser`); }
}

async function main() {
  // The window's code page would garble the server's "·" and any non-ASCII path.
  if (process.platform === "win32") spawnSync("cmd", ["/c", "chcp", "65001"], { stdio: "ignore", windowsHide: true });
  const root = dataRoot();
  const app = join(root, "app", `${VERSION}-${CONTENT}`);
  if (!existsSync(join(app, ".complete"))) {
    say(`setting up ${VERSION} (once)`);
    const staging = `${app}.tmp-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    unpack(staging);
    rmSync(app, { recursive: true, force: true });
    renameSync(staging, app);
    writeFileSync(join(app, ".complete"), VERSION);
  }
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  process.env.ARBITRA_WEB_DIST ??= join(app, "web");
  process.env.ARBITRA_PROTOCOL_ASSETS ??= join(app, "protocols");
  process.env.ARBITRA_BUILD ??= `${VERSION}, single-file app`;
  process.env.ARBITRA_REPOSITORY ??= data;
  // An npm-installed CLI (Codex) is a script for Node. This binary always runs arbitra, so it runs them with the Node
  // on PATH, which installing them through npm needs anyway.
  process.env.ARBITRA_NODE_EXECUTABLE ??= nodeOnPath() ?? "node";
  // Node's notices about its own experimental features (SQLite) mean nothing to the person reading this window.
  process.removeAllListeners("warning");
  process.chdir(data);
  const url = `http://127.0.0.1:${process.env.ARBITRA_PORT ?? "4178"}`;
  // A second start while arbitra runs opens it again instead of failing on the busy port.
  const running = await fetch(`${url}/diagnostics/environment`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.ok, () => false);
  if (running) { say(`already running on ${url}; opening it`); openBrowser(url); setTimeout(() => process.exit(0), 3_000); return; }
  const server = join(app, "server.cjs");
  const { serve } = createRequire(server)(server);
  await serve();
  openBrowser(url);
  say(`running on ${url}. Keep this window open; closing it stops arbitra. Runs are kept in ${data}`);
}

main().catch((error) => {
  say(`could not start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  say("copy the lines above and send them to whoever gave you arbitra. This window closes in two minutes.");
  setTimeout(() => process.exit(1), 120_000);
});
