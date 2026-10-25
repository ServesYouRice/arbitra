import { describe, expect, it } from "vitest";
import { REPOSITORY_INDEX_MAXIMUM_BYTES, repositoryIndex, symbolsOf } from "../src/repository-index.js";

function fileOf(path: string, lines: readonly string[]) {
  return { path, lines: [...lines], lineStartBytes: lines.map((_, index) => lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)), byteLength: Buffer.byteLength(lines.join("\n")) };
}

describe("the repository index every discovery unit carries", () => {
  it("keeps the index short on a large snapshot: every file while they fit, then the first that do and a count of the rest", () => {
    const symbols = (index: number) => Array.from({ length: 30 }, (_, symbol) => `export function handler${index}x${symbol}(): void {}`);
    const large = { root: "fixture", files: Array.from({ length: 2_000 }, (_, index) => fileOf(`packages/module-${String(Math.floor(index / 40)).padStart(2, "0")}/src/feature/file-${String(index).padStart(4, "0")}.ts`, symbols(index))) };
    const index = repositoryIndex(large);
    expect(index).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThanOrEqual(REPOSITORY_INDEX_MAXIMUM_BYTES);
    const listed = Object.values(index?.directories ?? {}).flat();
    expect(listed.length + (index?.omittedFiles ?? 0)).toBe(2_000);
    expect(index?.omittedFiles).toBeGreaterThan(0);
    expect(listed[0]).toBe("file-0000.ts 30");
    // A snapshot of ordinary size lists every file with its line count, and as many symbols as fit, a rank at a time.
    const medium = { root: "fixture", files: large.files.slice(0, 120) };
    const whole = repositoryIndex(medium);
    const entries = Object.values(whole?.directories ?? {}).flat();
    expect(whole?.omittedFiles).toBeUndefined();
    expect(entries).toHaveLength(120);
    expect(Buffer.byteLength(JSON.stringify(whole))).toBeLessThanOrEqual(REPOSITORY_INDEX_MAXIMUM_BYTES);
    expect(entries.every((entry) => /^file-\d{4}\.ts 30: handler\d+x0, /u.test(entry))).toBe(true);
    const counts = entries.map((entry) => entry.split(", ").length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    // Small enough, a file shows its first twelve symbols and how many more it has.
    expect(Object.values(repositoryIndex({ root: "fixture", files: large.files.slice(0, 3) })?.directories ?? {}).flat()[0]).toBe("file-0000.ts 30: handler0x0, handler0x1, handler0x2, handler0x3, handler0x4, handler0x5, handler0x6, handler0x7, handler0x8, handler0x9, handler0x10, handler0x11, +18");
    // A budget too small for a single file gives no index.
    expect(repositoryIndex(medium, 100)).toBeNull();
  });

  it("groups files by directory, the repository's top first", () => {
    const index = repositoryIndex({ root: "fixture", files: [fileOf("src/b.ts", ["export const b = 1;"]), fileOf("server.js", ["module.exports = start;"]), fileOf("src/a/c.py", ["def run(): pass"]), fileOf("index.html", ["<p></p>"])] });
    expect(index?.directories).toEqual({ ".": ["index.html 1", "server.js 1: start"], src: ["b.ts 1: b"], "src/a": ["c.py 1: run"] });
    expect(Object.keys(index?.directories ?? {})).toEqual([".", "src", "src/a"]);
  });

  it("lists each file's exported or top-level symbols across languages, and none for markup", () => {
    expect(symbolsOf("a.ts", ["import x from \"./x.js\";", "export default class Room {}", "export const enumValue = 1;", "export { open as start, type Closed };", "export async function* stream() {}", "function helper() {}"])).toEqual(["Room", "enumValue", "start", "Closed", "stream"]);
    expect(symbolsOf("lib/rooms.js", ["const fs = require(\"fs\");", "function create() {}", "module.exports = {", "  create,", "  remove: (id) => {", "    return id;", "  },", "  list() {},", "};"])).toEqual(["create", "remove", "list"]);
    expect(symbolsOf("scripts/run.js", ["const path = require(\"path\");", "const port = 8080;", "async function main() {}"])).toEqual(["port", "main"]);
    expect(symbolsOf("app/db.py", ["import os", "def _private(): pass", "class Store:", "    def method(self): pass", "async def connect(): pass"])).toEqual(["Store", "connect", "_private"]);
    expect(symbolsOf("main.go", ["package main", "func (s *Server) Serve() {}", "func helper() {}", "type Config struct {}"])).toEqual(["Server.Serve", "Config", "helper"]);
    expect(symbolsOf("src/lib.rs", ["fn private() {}", "pub fn open() {}", "pub(crate) struct Room;"])).toEqual(["open", "Room"]);
    expect(symbolsOf("src/main.c", ["#include <stdio.h>", "static int count(const char *text) {", "MODULE_LICENSE(\"GPL\");", "int main(void)", "struct packet {"])).toEqual(["count", "main", "packet"]);
    expect(symbolsOf("index.html", ["<script>function x() {}</script>"])).toEqual([]);
    // Only a line's head is read, so a minified line costs no more than a short one.
    expect(symbolsOf("min.js", [`var a=${"1,".repeat(100_000)}0;`])).toEqual(["a"]);
  });
});
