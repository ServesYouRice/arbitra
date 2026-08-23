import { describe, expect, it } from "vitest";

import { assembleRedactedContext, redactSecrets } from "../src/redaction.js";

describe("secret redaction", () => {
  it("redacts credentials and records only their locations and kinds", () => {
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const result = assembleRedactedContext(["Repository context", `token=${credential}`]);

    expect(result.text).toBe("Repository context\ntoken=[REDACTED:github_token]");
    expect(result.text).not.toContain(credential);
    expect(result.redactions).toEqual([
      expect.objectContaining({ kind: "github_token", replacement: "[REDACTED:github_token]" }),
    ]);
    expect(JSON.stringify(result.redactions)).not.toContain(credential);
  });

  it("redacts a private key before returning assembled context", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
    expect(assembleRedactedContext([key]).text).toBe("[REDACTED:private_key]");
  });

  it.each([
    "token budget = 12000",
    "password policy requires twelve characters",
    "const tokenName = 'semantic-token';",
    "Bearer is an authentication scheme",
  ])("preserves benign text: %s", (text) => {
    expect(redactSecrets(text)).toMatchObject({ text, redactions: [] });
  });
});
