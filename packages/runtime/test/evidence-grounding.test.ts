import { expect, it } from "vitest";
import { anchorLineEvidence, widenToQuote } from "../src/evidence-grounding.js";

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

it("matches a quote copied from the composed form the prompt shows, and keeps the file's own text", () => {
  // The prompt compiler sends source in normal form C; a file with a decomposed accent refused the exact copy.
  const decomposed = { ...file, lines: ["// sessions", "const label = \"café\";", "}"] };
  const quote = "const label = \"café\";";
  expect(anchorLineEvidence(evidence(2, 2, quote), decomposed)).toEqual(evidence(2, 2, "const label = \"café\";"));
  expect(anchorLineEvidence(evidence(3, 3, quote), decomposed)).toEqual(evidence(2, 2, "const label = \"café\";"));
  expect(widenToQuote({ startLine: 3, endLine: 3 }, quote, decomposed)).toEqual({ startLine: 2, endLine: 3 });
  expect(anchorLineEvidence(evidence(2, 2, "const label = \"cafe\";"), decomposed)).toBeNull();
});

it("matches a quotation of a line with a secret as the model was shown it, and keeps the secret masked", () => {
  // Found by arbitra's audit of itself (October 19, 2026): the model sees such a line masked, and its reply is masked again.
  const settings = { ...file, lines: ["// settings", "const apiKey = \"hunter2isNotSecret\";", "}"] };
  const shown = "const apiKey = \"[REDACTED:assigned_secret]\";";
  expect(anchorLineEvidence(evidence(2, 2, shown), settings)).toEqual(evidence(2, 2, shown));
  expect(anchorLineEvidence(evidence(3, 3, shown), settings)).toEqual(evidence(2, 2, shown));
  expect(widenToQuote({ startLine: 3, endLine: 3 }, shown, settings)).toEqual({ startLine: 2, endLine: 3 });
  expect(widenToQuote({ startLine: 1, endLine: 1 }, "apiKey = \"[REDACTED:assigned_secret]\"", settings)).toEqual({ startLine: 1, endLine: 2 });
  // A marker where the file holds no secret is still refused.
  expect(anchorLineEvidence(evidence(1, 1, "// [REDACTED:assigned_secret]"), settings)).toBeNull();
  expect(widenToQuote({ startLine: 1, endLine: 1 }, "// [REDACTED:assigned_secret]", settings)).toBeNull();
});

it("widens a cited range to its one nearby quotation and never elsewhere", () => {
  // Observed live: the quote starts with the doc comment one line above the cited function.
  expect(widenToQuote({ startLine: 4, endLine: 6 }, lines.slice(2, 6).join("\n"), file)).toEqual({ startLine: 3, endLine: 6 });
  expect(widenToQuote({ startLine: 3, endLine: 4 }, "  return now > session.expiresAt;", file)).toEqual({ startLine: 3, endLine: 5 });
  expect(widenToQuote({ startLine: 4, endLine: 6 }, "return now >= session.expiresAt;", file)).toBeNull();
  // "}" occurs several times near line 9: ambiguous.
  expect(widenToQuote({ startLine: 8, endLine: 8 }, "}", file)).toBeNull();
  expect(widenToQuote({ startLine: 20, endLine: 20 }, "x", { ...file, lines: [...Array.from({ length: 20 }, () => "y"), "z", "x"].reverse() })).toBeNull();
});

it("looks for the quotation only near the cited lines, so one repeated through a large file costs no more than elsewhere", () => {
  // Each occurrence anywhere in the file split the whole text before it into lines: 7.4 seconds for these 10,000 lines.
  const repeated = { ...file, lines: Array.from({ length: 10_000 }, (_, index) => Math.abs(index + 1 - 5_000) <= 8 && index + 1 !== 5_000 ? `const v${index + 1} = ${index};` : "x();") };
  const started = performance.now();
  expect(widenToQuote({ startLine: 5_001, endLine: 5_002 }, "x();", repeated)).toEqual({ startLine: 5_000, endLine: 5_002 });
  expect(widenToQuote({ startLine: 7_500, endLine: 7_500 }, "x();", repeated)).toBeNull();
  expect(widenToQuote({ startLine: 9_999, endLine: 10_004 }, "x();\nx();", repeated)).toBeNull();
  expect(performance.now() - started).toBeLessThan(1_000);
});

it("counts a quotation ending in a line break at the last line it may reach, and none past the file", () => {
  const short = { ...file, lines: ["a", "b", "c", "d", "e", "f", "g", "h", "target", "i"] };
  expect(widenToQuote({ startLine: 1, endLine: 4 }, "target\n", short)).toEqual({ startLine: 1, endLine: 9 });
  expect(widenToQuote({ startLine: 1, endLine: 3 }, "target\n", short)).toBeNull();
  expect(widenToQuote({ startLine: 8, endLine: 12 }, "i\n", short)).toBeNull();
  expect(widenToQuote({ startLine: 8, endLine: 12 }, "target\ni", short)).toEqual({ startLine: 8, endLine: 10 });
});
