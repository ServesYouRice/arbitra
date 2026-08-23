const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const path = require("node:path");

test("SeededRng reproduces an activity sequence across processes", () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../../../packages/core/src/services/rng.ts"),
  ).href;
  const script = [
    `import { SeededRng } from ${JSON.stringify(moduleUrl)};`,
    "const rng = new SeededRng('run-17').forActivity('review-order');",
    "console.log(JSON.stringify([rng.int(1000), rng.int(1000), rng.shuffle([1, 2, 3, 4, 5])]));",
  ].join("\n");

  const run = () => execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );

  assert.equal(run(), run());
});
