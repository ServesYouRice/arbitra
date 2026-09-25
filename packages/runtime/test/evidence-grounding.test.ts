import { expect, it } from "vitest";
import { anchorLineEvidence } from "../src/evidence-grounding.js";

const lines = ["// sessions", "", "/** doc */", "export function isExpired(session, now) {", "  return now > session.expiresAt;", "}", "", "throw new Error(\"EXPIRED\");", "}", "", "}"];
const file = { path: "src/session.js", lines, byteLength: 0, lineStartBytes: [] };
const evidence = (startLine: number, endLine: number, text: string) => ({ path: "src/session.js", startLine, endLine, text });

it("keeps exact evidence and re-anchors exact text quoted a line off", () => {
  const exact = evidence(4, 6, lines.slice(3, 6).join("\n"));
  expect(anchorLineEvidence(exact, file)).toBe(exact);
  expect(anchorLineEvidence(evidence(5, 7, exact.text), file)).toEqual(exact);
  expect(anchorLineEvidence(evidence(3, 5, exact.text), file)).toEqual(exact);
});

it("undoes only the untrusted-frame entity escaping and never approximates text", () => {
  expect(anchorLineEvidence(evidence(8, 8, "throw new Error(&quot;EXPIRED&quot;);"), file)).toEqual(evidence(8, 8, "throw new Error(\"EXPIRED\");"));
  expect(anchorLineEvidence(evidence(4, 6, "export function isExpired(session, now) {\n  return now >= session.expiresAt;\n}"), file)).toBeNull();
  expect(anchorLineEvidence(evidence(4, 4, "  return now"), file)).toBeNull();
});

it("refuses distant or ambiguous anchors and missing files", () => {
  expect(anchorLineEvidence(evidence(1, 1, "}"), { ...file, lines: [...Array.from({ length: 20 }, () => "x"), "}"] })).toBeNull();
  // Two equally near occurrences of "}" around line 7.5: ambiguous.
  expect(anchorLineEvidence(evidence(10, 10, "}"), file)).toBeNull();
  expect(anchorLineEvidence(evidence(10, 10, "}"), { ...file, lines: lines.slice(0, 10) })).toEqual(evidence(9, 9, "}"));
  expect(anchorLineEvidence(evidence(1, 1, "// sessions"), undefined)).toBeNull();
});

it("takes the quoted text as authoritative when the stated range has the wrong length", () => {
  const text = lines.slice(3, 6).join("\n");
  expect(anchorLineEvidence(evidence(3, 6, text), file)).toEqual(evidence(4, 6, text));
});
