import { describe, expect, it } from "vitest";
import { premiseKit, premiseScript, type PremiseIo, type PremiseSource } from "../src/premise-check.js";

const kit = premiseKit();
/** A repository held in memory. */
const repository = (files: Readonly<Record<string, string>>) => {
  const io: PremiseIo = { listFiles: () => Object.keys(files).sort(), readText: (_root, path) => files[path] ?? null, exists: (_root, path) => path in files };
  return kit.indexRepository("/repo", io);
};
const premise = (text: string): PremiseSource => ({ text, role: "premise" });
const checked = (files: Readonly<Record<string, string>>, sources: readonly PremiseSource[], hints: readonly string[] = []) => kit.check(kit.extract(sources), repository(files), hints);

describe("reading what a prompt names", () => {
  it("keeps a quote of code whole when it holds quotes of its own, and takes no apostrophe for a quote", () => {
    // Observed in nextra's plan (October 2026): "Quoted (transaction test): 'await transaction.request('StopStream'); ...'".
    const found = kit.extract([premise("Quoted (transaction test): 'await transaction.request('StopStream'); assert.deepEqual(await transaction.rollback(), []);' expecting the host's 'reclaim-host' event first.")]);
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "quote", text: "await transaction.request('StopStream'); assert.deepEqual(await transaction.rollback(), []);" }),
      expect.objectContaining({ kind: "event", text: "reclaim-host" })]));
    expect(found.filter(({ kind }) => kind === "quote")).toHaveLength(1);
  });

  it("reads an endpoint named in prose by its name, not by the words that describe it", () => {
    const routes = (text: string) => kit.extract([premise(text)]).filter(({ kind }) => kind === "route").map(({ words }) => words);
    expect(routes("Do not change the server-side implementation of the restore endpoint.")).toEqual([["restore"]]);
    expect(routes("A fixed endpoint, and the non-public endpoint, both answer.")).toEqual([]);
    expect(routes("Guard the shutdown and kill-media-worker endpoints.")).toEqual([["kill-media-worker"]]);
  });

  it("gives a quote the lines the prompt cites for it, and treats a block's lines with no header as excerpts of their own", () => {
    const found = kit.extract([premise("Lines 10-11 of src/a.js handle it: `const b = a + 1;`"),
      premise("<quotes>\nsrc/b.js:3-4\n  one();\n  two();\n</quotes>\n<quotes>\nsocket.on('close-viewer-transport', ({ transportId } = {}, callback)\nsocket.on('connect-transport', async ({ transportId } = {}, callback)\n</quotes>")]);
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "quote", text: "const b = a + 1;", expected: { path: "src/a.js", start: 10, end: 11 } }),
      expect.objectContaining({ kind: "quote", text: "one();\n  two();", expected: { path: "src/b.js", start: 3, end: 4 } }),
      expect.objectContaining({ kind: "quote", text: "socket.on('close-viewer-transport', ({ transportId } = {}, callback)" })]));
    expect(found.filter(({ kind, text }) => kind === "quote" && text.includes("connect-transport'"))).toHaveLength(1);
  });

  it("tells the change's new names apart from claims about the code", () => {
    const [registerUndo, onReconnect] = ["registerUndo", "onReconnect"].map((name) => kit.extract([{ text: "Add transaction.registerUndo(label, fn), then call it from onReconnect.", role: "change" },
      premise("onReconnect retries after a disconnect.")]).find(({ text }) => text.endsWith(name)));
    expect(registerUndo).toMatchObject({ creates: true, role: "change" });
    expect(onReconnect).toMatchObject({ role: "premise" });
    // A name the text says is missing, or gives as an example, is not a premise that it exists.
    expect(kit.extract([premise("The helper never sets `NODE_TLS_REJECT_UNAUTHORIZED`."), premise("It uses no agent (e.g. `undiciAgent`).")]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ text: "NODE_TLS_REJECT_UNAUTHORIZED", absent: true }), expect.objectContaining({ text: "undiciAgent", creates: true })]));
  });
});

describe("looking it up in the code", () => {
  it("finds a route under the path its router is mounted at, and a concrete path for a parametered one", () => {
    const files = { "server.js": "app.use('/whep', router);\n", "lib/whep.js": "router.delete('/watch/:sessionId', handler);\nrouter.post('/:roomCode', start);\n" };
    const saved = checked(files, [premise("DELETE /whep/watch/:id ends a session; POST /whep/AB12CD starts one; GET /api/restore does not exist.")]);
    expect(saved.filter(({ kind }) => kind === "route").map(({ text, saved: { status } }) => [text, status])).toEqual([["DELETE /whep/watch/:id", "found"], ["POST /whep/AB12CD", "found"], ["GET /api/restore", "missing"]]);
  });

  it("finds quoted code whatever its spacing or quoting, and says when its statements are there in another order", () => {
    const files = { "lib/relay.js": "const args = [\n  '-frames:v', '1',\n  '-c:v', 'h264_nvenc',\n];\nfunction stop() {\n  recorder.stop();\n  recorderRef.current = null;\n}\n" };
    const [args, order] = checked(files, [premise("It probes with `-frames:v 1 -c:v h264_nvenc`."), premise("Quoted: `recorderRef.current = null; recorder.stop();`")]);
    expect(args).toMatchObject({ kind: "quote", saved: { status: "found", place: { path: "lib/relay.js", start: 2, end: 3 } }, flagged: false });
    // Observed in nextra's plan (October 2026): a prompt said a ref was cleared before stop(); the code cleared it after.
    expect(order).toMatchObject({ kind: "quote", saved: { status: "partial", unmatched: ["recorder.stop()"] }, flagged: true });
    expect(kit.notFoundLine(order as NonNullable<typeof order>)).toBe("quote `recorderRef.current = null; recorder.stop();`: all of it is there, in another order than quoted, at lib/relay.js:6-7");
  });

  it("finds a quoted call whose other arguments the quote leaves out, and a name the code uses as the start of a longer one", () => {
    // Observed on nextra's plan (October 2026): `transport.on('dtlsstatechange')` for `transport.on('dtlsstatechange', (state) => …)`,
    // and "the HowTo view" for `HowToView`.
    const files = { "lib/socket.js": "transport.on('dtlsstatechange', (state) => maybeHandle('dtls', state));\n", "src/App.jsx": "const HowToView = lazy(() => import('./HowToView'));\n" };
    const saved = checked(files, [premise("It listens with `transport.on('dtlsstatechange')`, and the HowTo view links to it.")]);
    expect(saved.map(({ text, saved: { status, place } }) => [text, status, place?.path])).toEqual([["transport.on('dtlsstatechange')", "found", "lib/socket.js"], ["HowTo", "found", "src/App.jsx"]]);
  });

  it("of two copies of a quote, takes the one nearest the lines the prompt cites", () => {
    const files = { "a.js": ["x();", ...Array.from({ length: 30 }, () => "// filler"), "x();", ""].join("\n") };
    const [quote] = checked(files, [premise("Line 32 of a.js: `x();` runs twice.")]);
    expect(quote?.saved.place).toEqual({ path: "a.js", start: 32, end: 32 });
  });

  it("takes the platform's names for the platform's, and a name a document alone uses for no false premise", () => {
    const files = { "src/a.js": "export const a = 1;\n", "README.md": "Built on WebTransportish.\n" };
    const saved = checked(files, [premise("Promise.allSettled waits; a RangeError is thrown; net.isIP checks; WebTransportish carries it; `missingHelper()` does it.")]);
    expect(saved.filter(({ flagged }) => flagged).map(({ text }) => text)).toEqual(["missingHelper"]);
  });

  it("places a name where the code uses it before where a test stands in for it", () => {
    // Observed on nextra's dev history (October 2026): `writeEncoderSettings`, a parameter in the source, was placed at
    // a test's mock of it.
    const files = { "src/obs.js": "export async function configure({ writeEncoderSettings = null } = {}) {\n  await writeEncoderSettings();\n}\n",
      "tests/obs.test.js": "const fake = { writeEncoderSettings: async () => ({ applied: true }) };\n" };
    const [name] = checked(files, [premise("configure awaits writeEncoderSettings first.")], ["src/obs.js"]).filter(({ text }) => text === "writeEncoderSettings");
    expect(name?.saved.place).toEqual({ path: "src/obs.js", start: 1, end: 1 });
  });

  it("does not mark a name another prompt adds, and records which one", () => {
    // Observed in nextra's plan (October 2026): "this task builds on TASK-005's parseForwardedLast".
    const repo = repository({ "lib/network.js": "export function parseForwardedFirst() {}\n" });
    const first = kit.check(kit.extract([{ text: "Add parseForwardedLast(header) to lib/network.js.", role: "change" }]), repo, []);
    const second = kit.check(kit.extract([premise("This task builds on TASK-005's parseForwardedLast.")]), repo, []);
    expect(second[0]).toMatchObject({ text: "parseForwardedLast", flagged: true });
    const settled = kit.settle(new Map([["TASK-005", first], ["TASK-094", second]]));
    expect(settled.get("TASK-094")?.[0]).toMatchObject({ flagged: false, addedBy: ["TASK-005"] });
  });

  it("finds cited lines again by the code they held when the plan was saved", () => {
    const before = { "a.js": "one();\nconst two = makeTwo();\nthree();\n" };
    const [lines] = checked(before, [premise("a.js:2 makes the second one.")]);
    expect(lines).toMatchObject({ kind: "lines", excerpt: "const two = makeTwo();", saved: { place: { path: "a.js", start: 2, end: 2 } } });
    const moved = kit.compare(lines === undefined ? [] : [lines], repository({ "a.js": "zero();\none();\nconst two = makeTwo();\n" }), []);
    expect(moved[0]).toMatchObject({ change: "moved", now: { place: { path: "a.js", start: 3, end: 3 } } });
  });
});

it("ships as one script with no imports but Node's own", () => {
  const script = premiseScript();
  expect(script.split("\n").filter((line) => line.startsWith("import ")).every((line) => /from "node:[a-z_]+";$/u.test(line))).toBe(true);
  expect(script).toContain("const kit = (function premiseKit()");
});
