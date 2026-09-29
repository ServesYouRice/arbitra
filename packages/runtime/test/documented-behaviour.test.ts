import { describe, expect, it } from "vitest";
import { documentedBehaviourConflictSchema } from "@arbitra/schemas/documented-behaviour.js";
import { conflictReason, groundBehaviourConflicts, groundRequirementConflicts } from "../src/documented-behaviour.js";

// The live fixture whose seeded bug a Testing writer pinned as correct.
const lines = ["/** A session is valid strictly before its expiry instant. */", "export function isExpired(session, now) {", "  return now > session.expiresAt;", "}"];
const snapshot = { root: "fixture", files: [{ path: "src/session.js", lines, lineStartBytes: lines.map((_, index) => lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0)), byteLength: lines.join("\n").length }] };
const request = "Refresh extends only live sessions, and expiry is enforced exactly at expiresAt.";
const conflict = (documentation: { path: string | null; startLine: number | null; endLine: number | null; text: string }, code = { path: "src/session.js", startLine: 3, endLine: 3, text: "return now > session.expiresAt;" }) =>
  documentedBehaviourConflictSchema.parse({ documentation, code, explanation: "At now === expiresAt the doc says expired; the code says valid." });
const docComment = { path: "src/session.js", startLine: 1, endLine: 1, text: lines[0] ?? "" };

describe("documented-behaviour conflicts", () => {
  it("accepts exact quotations and corrects only a miscounted or short range", () => {
    expect(groundBehaviourConflicts([conflict(docComment)], snapshot)[0]).toMatchObject({ documentation: docComment, code: { startLine: 3, endLine: 3 } });
    // Whole-line quotation one line off, and a phrase whose cited range stops short of it.
    const [moved] = groundBehaviourConflicts([conflict({ ...docComment, startLine: 2, endLine: 3, text: "valid strictly before" }, { path: "src/session.js", startLine: 2, endLine: 2, text: lines[2] ?? "" })], snapshot);
    expect(moved?.code).toMatchObject({ startLine: 3, endLine: 3 });
    expect(moved?.documentation).toMatchObject({ startLine: 1, endLine: 3 });
    expect(conflictReason(conflict(docComment))).toBe("documented_behaviour_conflict:src/session.js:3");
  });

  it("accepts a quotation of the request only where there is one", () => {
    const fromRequest = conflict({ path: null, startLine: null, endLine: null, text: "expiry is enforced exactly at expiresAt" });
    expect(groundBehaviourConflicts([fromRequest], snapshot, request)).toHaveLength(1);
    expect(() => groundBehaviourConflicts([fromRequest], snapshot)).toThrow("must quote a repository file");
    expect(() => groundBehaviourConflicts([conflict({ path: null, startLine: null, endLine: null, text: "expiry is lenient" })], snapshot, request)).toThrow("exact excerpt of the request");
  });

  it("refuses invented quotations, unknown requirements and partly located documentation", () => {
    expect(() => groundBehaviourConflicts([conflict(docComment, { path: "src/session.js", startLine: 3, endLine: 3, text: "return now >= session.expiresAt;" })], snapshot)).toThrow("DOCUMENTED_BEHAVIOUR_CONFLICT_UNGROUNDED: documentedBehaviourConflicts[0].code.text");
    expect(() => groundBehaviourConflicts([conflict({ ...docComment, text: "A session never expires." })], snapshot)).toThrow("documentedBehaviourConflicts[0].documentation.text");
    expect(() => groundRequirementConflicts([{ requirementIds: ["AC-9"], ...conflict(docComment) }], new Set(["AC-1"]), snapshot, request)).toThrow("DOCUMENTED_BEHAVIOUR_CONFLICT_UNKNOWN_REQUIREMENT");
    expect(documentedBehaviourConflictSchema.safeParse({ documentation: { path: null, startLine: 1, endLine: null, text: "x" }, code: docComment, explanation: "x" }).success).toBe(false);
  });
});
