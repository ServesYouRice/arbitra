import { describe, expect, it } from "vitest";
import { buildSymbolIndex, symbolName } from "../src/repo/symbol-index.js";

const definitionOf = (path: string, source: string, name: string) => {
  const index = buildSymbolIndex([{ path, lines: source.split("\n") }]);
  return index.definitions(name).map(({ startLine, endLine }) => [startLine, endLine]);
};

describe("the symbol index", () => {
  it.each([
    ["TypeScript function", "a.ts", "const other = 1;\nexport async function load(id: string): Promise<void> {\n  if (id) { run(); }\n}\nconst after = 2;", "load", [[2, 4]]],
    ["TypeScript arrow", "a.ts", "export const load = async (id: string) => {\n  run(id);\n};\nconst after = 2;", "load", [[1, 3]]],
    ["TypeScript type", "a.ts", "export type Load = {\n  id: string;\n};\nexport interface Other { id: string }", "Load", [[1, 3]]],
    ["TypeScript one-line constant", "a.ts", "const LIMIT = 12;\nconst after = 2;", "LIMIT", [[1, 1]]],
    ["TypeScript method", "a.ts", "class Store {\n  private async load(id: string): Promise<void> {\n    run(id);\n  }\n}", "load", [[2, 4]]],
    ["TSX component with a brace in a string", "a.tsx", "export function Row() {\n  const open = \"{\";\n  return <div>{open}</div>;\n}\nconst after = 1;", "Row", [[1, 4]]],
    ["JavaScript function", "a.js", "function load() {\n  return 1;\n}", "load", [[1, 3]]],
    ["Elixir function", "a.ex", "defmodule Rooms do\n  def close(room) do\n    room\n  end\n\n  defp hidden?(room), do: room\nend", "close", [[2, 4]]],
    ["Elixir one-line private function with a question mark", "a.ex", "defmodule Rooms do\n  defp hidden?(room), do: room\nend", "hidden?", [[2, 2]]],
    ["Elixir module, by its last segment", "a.ex", "defmodule My.Rooms do\n  def close(room), do: room\nend", "Rooms", [[1, 3]]],
    ["Go function", "a.go", "package a\n\nfunc Load(id string) error {\n\treturn nil\n}\n", "Load", [[3, 5]]],
    ["Go method", "a.go", "func (s *Store) Load(id string) error {\n\treturn nil\n}\n", "Load", [[1, 3]]],
    ["Go type", "a.go", "type Store struct {\n\tid string\n}\n", "Store", [[1, 3]]],
    ["Python function, ending where it dedents", "a.py", "def load(a,\n         b):\n    if a:\n        return b\n\n    return a\n\nvalue = 1", "load", [[1, 6]]],
    ["Python method", "a.py", "class Store:\n    def load(self):\n        return 1\n\n    def save(self):\n        return 2", "load", [[2, 3]]],
    ["Python class", "a.py", "class Store:\n    def load(self):\n        return 1\n\nvalue = 1", "Store", [[1, 3]]],
    ["Java method", "A.java", "public class A {\n  public static int load(String id) throws IOException {\n    return 1;\n  }\n}", "load", [[2, 4]]],
    ["Java class", "A.java", "public final class A {\n  int b;\n}", "A", [[1, 3]]],
    ["Dart class", "a.dart", "class Store extends Base {\n  int b = 1;\n}", "Store", [[1, 3]]],
    ["Dart method", "a.dart", "class Store {\n  Future<void> load(String id) async {\n    run();\n  }\n}", "load", [[2, 4]]],
    ["Rust function", "a.rs", "pub async fn load(id: &str) -> Result<()> {\n    Ok(())\n}", "load", [[1, 3]]],
    ["Rust struct", "a.rs", "#[derive(Debug)]\npub struct Store {\n    id: u32,\n}", "Store", [[2, 4]]],
    ["C function", "a.c", "int load(const char *id)\n{\n  return 1;\n}\nint after;", "load", [[1, 4]]],
    ["C prototype is no definition", "a.h", "int load(const char *id);", "load", []],
    ["C++ struct", "a.cpp", "struct Store {\n  int id;\n};", "Store", [[1, 3]]],
    ["C macro", "a.h", "#define LIMIT 12\nint after;", "LIMIT", [[1, 1]]],
    ["a language it does not know has no definition", "a.zzz", "function load() {\n}\n", "load", []],
  ] as const)("finds a definition and its whole body: %s", (_label, path, source, name, expected) => {
    expect(definitionOf(path, source, name)).toEqual(expected);
  });

  it("does not take a call or a keyword for a definition", () => {
    expect(definitionOf("a.ts", "class A {\n  run() {\n    if (x) {\n      load(1);\n    }\n  }\n}", "if")).toEqual([]);
    expect(definitionOf("a.ts", "export function run() {\n  load(1);\n}\n", "load")).toEqual([]);
    expect(definitionOf("A.java", "class A {\n  void run() {\n    return load(1);\n  }\n}", "load")).toEqual([]);
  });

  it("cuts a body that does not end within its limit and says so", () => {
    const lines = ["export function endless() {", ...Array.from({ length: 500 }, () => "  run();")];
    const [definition] = buildSymbolIndex([{ path: "a.ts", lines }]).definitions("endless");
    expect(definition).toMatchObject({ startLine: 1, endLine: 200, cut: true });
  });

  it("lists references as whole words, without the definition's line, in path and line order, the same every time", () => {
    const files = [
      { path: "z.ts", lines: ["load();", "reload();", "loader();"] },
      { path: "a.ts", lines: ["export function load() {", "  return load.name;", "}"] },
      { path: "doc.txt", lines: ["call load here"] },
    ];
    const references = buildSymbolIndex(files).references("load");
    expect(references).toEqual([{ path: "a.ts", line: 2 }, { path: "doc.txt", line: 1 }, { path: "z.ts", line: 1 }]);
    expect(buildSymbolIndex([...files].reverse()).references("load")).toEqual(references);
  });

  it("reads names with a question mark or an exclamation mark only where the language has them", () => {
    const elixir = buildSymbolIndex([{ path: "a.ex", lines: ["ok?(x)", "ok(x)"] }]);
    expect(elixir.references("ok?")).toEqual([{ path: "a.ex", line: 1 }]);
    expect(elixir.references("ok")).toEqual([{ path: "a.ex", line: 2 }]);
    expect(buildSymbolIndex([{ path: "a.ts", lines: ["const b = ok?.c;"] }]).references("ok")).toEqual([{ path: "a.ts", line: 1 }]);
  });

  it("leaves a minified line out of the references rather than scan it", () => {
    expect(buildSymbolIndex([{ path: "a.js", lines: [`${"x".repeat(5_000)} load`] }]).references("load")).toEqual([]);
  });

  it.each([
    ["setUser(", "setUser"],
    ["  queryClient.clear  ", "clear"],
    ["Nananananana.Posts.get_post/2", "get_post"],
    ["Foo::bar", "bar"],
    ["Foo#bar", "bar"],
    ["def show", "show"],
    ["export interface PostReference", "PostReference"],
    ["hidden?", "hidden?"],
    ["save!(x)", "save!"],
    ["a b(c)", "b"],
  ])("takes the name out of how a model asks for it: %s", (raw, name) => {
    expect(symbolName(raw)).toBe(name);
  });

  it("refuses text that holds no name", () => {
    expect(symbolName("  ")).toBeNull();
    expect(symbolName("=>")).toBeNull();
  });
});
