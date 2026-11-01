import { describe, expect, it } from "vitest";
import { RELATED_SOURCE_LIMITS, relatedSourceFinder, type ContextFile } from "../src/verification-context.js";

const file = (path: string, text: string): ContextFile => ({ path, lines: text.split("\n") });

const controller = file("lib/web/draft_controller.ex", [
  "defmodule Web.DraftController do",
  "  def publish(conn, %{\"id\" => id}) do",
  "    draft = Posts.get_draft(id)",
  "    Posts.publish_draft(draft, conn.assigns.profile)",
  "  end",
  "end",
].join("\n"));
const posts = file("lib/core/posts.ex", [
  "defmodule Core.Posts do",
  "  def get_draft(id) do",
  "    Repo.get(Draft, id)",
  "  end",
  "",
  "  def publish_draft(draft, profile) do",
  "    if draft.profile_id == profile.id do",
  "      {:ok, draft}",
  "    end",
  "  end",
  "end",
].join("\n"));
const router = file("lib/web/router.ex", ["scope \"/api\" do", "  post \"/drafts/:id/publish\", DraftController, :publish", "  # publish is also documented here", "end"].join("\n"));
const caller = file("lib/web/other_controller.ex", ["defmodule Web.OtherController do", "  def go(conn) do", "    DraftController.publish(conn, %{\"id\" => 1})", "  end", "end"].join("\n"));

const location = { path: controller.path, startLine: 3, endLine: 4 };

describe("the related source a verification question is handed", () => {
  it("supplies where a name used at the cited lines is defined, in a file the findings do not cite", () => {
    const related = relatedSourceFinder([controller, posts, router, caller])([location]);
    // The module first (named twice at the cited lines), then each function by how often it is used.
    expect(related?.definitions.map(({ at }) => at)).toEqual(["lib/core/posts.ex:1-11", "lib/core/posts.ex:2-4", "lib/core/posts.ex:6-10"]);
    expect(related?.definitions[1]).toMatchObject({ trust: "untrusted_data", content: "2:   def get_draft(id) do\n3:     Repo.get(Draft, id)\n4:   end" });
    expect(related?.definitions[2]?.why).toBe("defines publish_draft, used at the cited lines");
  });

  it("supplies the places that call the function the cited lines sit in, nearest the cited file first, and not comments or definitions", () => {
    const related = relatedSourceFinder([controller, posts, router, caller])([location]);
    expect(related?.callers.map(({ at }) => at)).toEqual(["lib/web/other_controller.ex:1-5", "lib/web/router.ex:1-4"]);
    expect(related?.callers[0]?.why).toBe("calls publish, which the cited lines are part of");
    // Nothing from the cited file itself, and the comment in the router is not a call.
    expect(related?.callers.every(({ at }) => !at.startsWith(controller.path))).toBe(true);
  });

  it("leaves out a name the cited files define themselves and one defined in many places", () => {
    const twin = (index: number) => file(`lib/twin${index}.ex`, "def get_draft(id) do\n  id\nend");
    const related = relatedSourceFinder([controller, posts, twin(1), twin(2), twin(3)])([location]);
    expect(related?.definitions.map(({ at }) => at)).toEqual(["lib/core/posts.ex:1-11", "lib/core/posts.ex:6-10"]);
    const own = relatedSourceFinder([file("lib/web/own.ex", "defmodule Own do\n  def get_draft(id), do: id\n  def uses(id), do: get_draft(id)\nend"), posts])([{ path: "lib/web/own.ex", startLine: 3, endLine: 3 }]);
    expect(own?.definitions ?? []).toEqual([]);
  });

  it("is bounded in bytes and in the number of excerpts, and gives the same context every time", () => {
    const long = file("lib/long.ex", ["def get_draft(id) do", ...Array.from({ length: 200 }, (_, index) => `  line_${index}(${"x".repeat(80)})`), "end"].join("\n"));
    const callers = Array.from({ length: 12 }, (_, index) => file(`lib/web/c${index}.ex`, `x = publish(conn, ${index})`));
    const find = relatedSourceFinder([controller, long, ...callers]);
    const related = find([location]);
    const bytes = [...(related?.definitions ?? []), ...(related?.callers ?? [])].reduce((sum, { content }) => sum + Buffer.byteLength(content), 0);
    expect(bytes).toBeLessThanOrEqual(RELATED_SOURCE_LIMITS.bytes);
    expect(related?.callers.length).toBeLessThanOrEqual(RELATED_SOURCE_LIMITS.callersPerName);
    expect(related?.definitions[0]?.content.split("\n").length).toBeLessThanOrEqual(RELATED_SOURCE_LIMITS.definitionLines);
    expect(JSON.stringify(find([location]))).toBe(JSON.stringify(related));
    expect(JSON.stringify(relatedSourceFinder([...callers].reverse().concat(long, controller))([location]))).toBe(JSON.stringify(related));
  });

  it("gives nothing for code it cannot read, a name used everywhere, or places that are not in the snapshot", () => {
    const markup = file("page.html", "<p>publish_draft get_draft</p>");
    expect(relatedSourceFinder([markup, controller])([{ path: "page.html", startLine: 1, endLine: 1 }])).toBeNull();
    const everywhere = Array.from({ length: 30 }, (_, index) => file(`lib/u${index}.ex`, "publish(conn)"));
    expect(relatedSourceFinder([controller, ...everywhere])([{ path: controller.path, startLine: 2, endLine: 2 }])?.callers ?? []).toEqual([]);
    expect(relatedSourceFinder([controller])([{ path: "missing.ex", startLine: 1, endLine: 2 }])).toBeNull();
    expect(relatedSourceFinder([controller, posts])([])).toBeNull();
  });

  it("reads TypeScript the same way", () => {
    const page = file("src/page.ts", ["export async function save(draft: Draft) {", "  return await uploadDraftImage(draft.image);", "}"].join("\n"));
    const client = file("src/api/client.ts", ["export const uploadDraftImage = async (file: File) => {", "  return fetch(\"/upload\", { body: file });", "};", "", "export const other = () => 1;"].join("\n"));
    const use = file("src/use-save.ts", "const saved = await save(draft);");
    const related = relatedSourceFinder([page, client, use])([{ path: "src/page.ts", startLine: 2, endLine: 2 }]);
    expect(related?.definitions.map(({ at }) => at)).toEqual(["src/api/client.ts:1-3"]);
    expect(related?.callers.map(({ at }) => at)).toEqual(["src/use-save.ts:1-1"]);
  });
});
