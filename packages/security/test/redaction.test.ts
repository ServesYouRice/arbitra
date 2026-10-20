import { describe, expect, it } from "vitest";

import { assembleRedactedContext, maskPrivateKeyBlocks, redactNamedValue, redactSecrets } from "../src/redaction.js";

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

  it("redacts JSON credential values and keeps redacted output stable", () => {
    const raw = JSON.stringify({ password: "arbitrary-long-secret", apiKey: "sk-abcdefghijklmnop" });
    const redacted = redactSecrets(raw);
    expect(redacted.text).not.toContain("arbitrary-long-secret");
    expect(redacted.text).not.toContain("sk-abcdefghijklmnop");
    expect(redactSecrets(redacted.text)).toMatchObject({ text: redacted.text, redactions: [] });
  });

  it("leaves the escape of a following quote in place, so JSON text stays JSON", () => {
    // Observed live (P20 pilot): a source line ending in an assignment sat in JSON nested in a stored prompt.
    const nested = JSON.stringify({ lines: [{ line: 1, text: "    apiKey: gw7KeyForTheGateway," }, { line: 2, text: "    clock," }] });
    const stored = JSON.stringify({ text: nested });
    const once = redactSecrets(stored);
    expect(once.text).not.toContain("gw7KeyForTheGateway");
    const lines = (JSON.parse((JSON.parse(once.text) as { text: string }).text) as { lines: { text: string }[] }).lines;
    expect(lines.map(({ text }) => text)).toEqual(["    apiKey: [REDACTED:assigned_secret]", "    clock,"]);
    // A marker followed by an escaped quote is not a secret again.
    expect(redactSecrets(once.text)).toMatchObject({ text: once.text, redactions: [] });
  });

  it("redacts a string filed under a secret's name without touching encoded JSON", () => {
    expect(redactNamedValue("password", "arbitrary-long-secret")).toBe("[REDACTED:assigned_secret]");
    expect(redactNamedValue("apiKey", "sk-abcdefghijklmnop")).toMatch(/^\[REDACTED:(?:api_token|assigned_secret)\]$/u);
    expect(redactNamedValue("title", "arbitrary-long-title")).toBe("arbitrary-long-title");
    expect(redactNamedValue("excerpt", "const apiKey = 'sk-abcdefghijklmnop';")).not.toContain("sk-abcdefghijklmnop");
  });

  it("leaves code that names where a secret comes from, and masks anything that may be the secret", () => {
    // Observed live (P20 pilot): masking these lines hid how a project generated its lease tokens.
    for (const code of [
      "const grant = { token: this.deps.ids.leaseToken(), workerId };",
      "  const token = env.JOBWELL_ADMIN_TOKEN ?? \"\";",
      "await runCli([\"dead\"], { token: TOKENS.emails, transport });",
      "    apiKey: config.gateway.apiKey,",
      "password = readPassword(prompt);",
    ]) expect(redactSecrets(code)).toMatchObject({ text: code, redactions: [] });
    for (const secret of [
      "token: 'plainLongSecretValue'",
      "password = \"correct.horse.battery\"",
      "token=abcdefghijklmnop",
      "apiKey: process.env.KEY_V2_LONGNAME",
      "secret: eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
    ]) expect(redactSecrets(secret).redactions.map(({ kind }) => kind)).toEqual(["assigned_secret"]);
  });

  it("finds secrets under prefixed names, masks named values whole and private keys line by line", () => {
    // Found by arbitra's audit of itself (October 19, 2026).
    for (const line of ["DB_PASSWORD=hunter2isNotSecret", "AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIK7MDENG'", "client_secret = \"abcdefghijk1\"", "clientSecret: 'abcdefghijk1'"])
      expect(redactSecrets(line).redactions.map(({ kind }) => kind)).toEqual(["assigned_secret"]);
    expect(redactNamedValue("password", "correct horse battery staple")).toBe("[REDACTED:assigned_secret]");
    expect(redactNamedValue("dbPassword", "correct.horse.battery.staple")).toBe("[REDACTED:assigned_secret]");
    expect(redactNamedValue("maxTokens", "12000")).toBe("12000");
    const file = ["const a = 1;", "-----BEGIN ENCRYPTED PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "-----END ENCRYPTED PRIVATE KEY-----", "const b = 2;"].join("\n");
    expect(maskPrivateKeyBlocks(file).split("\n")).toEqual(["const a = 1;", "[REDACTED:private_key]", "[REDACTED:private_key]", "[REDACTED:private_key]", "const b = 2;"]);
    expect(maskPrivateKeyBlocks("x\n-----BEGIN RSA PRIVATE KEY-----\nbody")).toBe("x\n[REDACTED:private_key]\n[REDACTED:private_key]");
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
