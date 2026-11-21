// One release: `pnpm release <version>`. From a clean checkout it runs the full check (`pnpm run ci`, `pnpm build`
// and the browser acceptance), builds the Windows app with tooling/package/build.mjs, copies it to
// dist-release/v<version>/arbitra-<version>-windows.exe with a SHA-256 file next to it, and prints the commands that
// tag and upload it. It never runs them: a tag and a release are the owner's to make (AGENTS.md). GitHub adds the
// source zip to the release from the tag.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "./node-download.mjs";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

/** The version asked for, without a leading "v"; anything else is refused before any work starts. */
export function releaseVersion(argv) {
  if (argv.length !== 1) throw new Error("usage: pnpm release <version>, for example pnpm release 0.5.0");
  const version = argv[0].replace(/^v/u, "");
  if (!SEMVER.test(version)) throw new Error(`${argv[0]} is not a version such as 0.5.0`);
  return version;
}

/** The asset as the releases name it, and its SHA-256 file in the format `sha256sum -c` and `shasum -a 256 -c` read. */
export function releaseFiles(version, bytes) {
  const asset = `arbitra-${version}-windows.exe`;
  return { asset, checksum: `${asset}.sha256`, checksumText: `${sha256(bytes)}  ${asset}\n` };
}

/** What to run once the owner agrees to publish: the tag on the commit that passed, and the upload. */
export function publishCommands(version, commit, paths) {
  return [
    `git tag -a v${version} ${commit} -m "arbitra ${version}"`,
    `git push origin v${version}`,
    `gh release create v${version} --verify-tag --title "arbitra ${version}" ${paths.join(" ")}`,
  ];
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const version = releaseVersion(argv);
  const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && command === "pnpm", ...options });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const say = (text) => process.stdout.write(`release: ${text}\n`);

  if (git("status", "--porcelain") !== "") throw new Error("the working tree has changes: commit them, so the release is the commit that passed the check");
  if (git("tag", "--list", `v${version}`) !== "") throw new Error(`the tag v${version} already exists`);
  const commit = git("rev-parse", "HEAD");

  say(`the full check on ${commit.slice(0, 7)}`);
  run("pnpm", ["run", "ci"]);
  run("pnpm", ["build"]);
  run("pnpm", ["--filter", "@arbitra/web", "e2e"]);
  say("building the Windows app");
  run(process.execPath, [join(root, "tooling", "package", "build.mjs"), "win-x64", version]);
  if (git("status", "--porcelain") !== "" || git("rev-parse", "HEAD") !== commit) throw new Error("the check or the build changed the checkout; review it and release again");

  const out = join(root, "dist-release", `v${version}`);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const built = join(root, "dist-package", "win-x64", "arbitra.exe");
  const { asset, checksum, checksumText } = releaseFiles(version, readFileSync(built));
  copyFileSync(built, join(out, asset));
  writeFileSync(join(out, checksum), checksumText);
  const paths = [asset, checksum].map((name) => relative(root, join(out, name)).replaceAll("\\", "/"));

  say(`v${version} from ${commit} passed the full check`);
  for (const path of paths) say(`  ${path}`);
  say(`  SHA-256 ${checksumText.split(" ")[0]}`);
  say("Nothing was tagged, pushed or uploaded. To publish it, once the owner agrees:");
  for (const command of publishCommands(version, commit, paths)) say(`  ${command}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
}
