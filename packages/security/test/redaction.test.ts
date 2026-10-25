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
    expect(lines.map(({ text }) => text)).toEqual(["    apiKey: [REDACTED:assigned_secret],", "    clock,"]);
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
      // Observed live (rokbot, October 24, 2026): these hid how the capability token was made and compared.
      "        self.capability_token = secrets.token_urlsafe(32)",
      "            header_token = Headers(scope=scope).get(\"x-rokbot-capability\")",
      "    token = production_client.get(\"/safety/capability\").json()[\"token\"]",
      "const sessionToken = crypto.randomBytes(32).toString(\"hex\");",
      "token = request.headers[TOKEN_HEADER]",
      // Found by arbitra's audit of itself (October 19, 2026): this line of the redactor reached the auditors masked.
      "      const secret = match[detector.secretGroup];",
    ]) expect(redactSecrets(code)).toMatchObject({ text: code, redactions: [] });
    for (const secret of [
      "token: 'plainLongSecretValue'",
      "password = \"correct.horse.battery\"",
      "token=abcdefghijklmnop",
      "apiKey: process.env.KEY_V2_LONGNAME",
      "secret: eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
      "password=Xy7k(q.Lm)zz",
      "token: \"getToken(abc)defg\"",
    ]) expect(redactSecrets(secret).redactions.map(({ kind }) => kind)).toEqual(["assigned_secret"]);
  });

  it("masks a quoted secret in JSON-encoded source, and a secret inside code that is left in place", () => {
    // A prompt carries whole files as JSON strings, in which a source file's quotes are escaped.
    for (const source of [
      "const password = \"hunter2isNotSecret\";",
      "{\n  \"password\": \"hunter2isNotSecret\"\n}",
      "session_token = connect(password=hunter2isNotSecret)",
      "token = this.ids.leaseToken();\napi_key=hunter2isNotSecret",
    ]) {
      const encoded = JSON.stringify({ path: "app.py", content: source });
      for (const text of [source, encoded, JSON.stringify({ text: encoded })]) expect(redactSecrets(text).text).not.toContain("hunter2isNotSecret");
    }
  });

  it("ends a masked value at an escaped line break, so JSON-encoded source keeps its lines", () => {
    // Found by arbitra's audit of itself (October 19, 2026): the masked value took the escaped line break and the
    // next line with it, and auditors reported a syntax error the source does not have.
    const source = ["password=hunter2isNotSecret", "next_line = 1", "  const token = env.JOBWELL_ADMIN_TOKEN;", "  return token;"];
    const once = JSON.stringify({ path: "app.py", content: source.join("\n") });
    const twice = JSON.stringify({ text: once });
    const content = (text: string) => (JSON.parse(text) as { content: string }).content.split("\n");
    const redacted = { once: redactSecrets(once).text, twice: redactSecrets(twice).text };
    expect(content(redacted.once)).toEqual(["password=[REDACTED:assigned_secret]", ...source.slice(1)]);
    expect(content((JSON.parse(redacted.twice) as { text: string }).text)).toEqual(content(redacted.once));
    for (const text of Object.values(redacted)) expect(redactSecrets(text)).toMatchObject({ text, redactions: [] });
  });

  it("leaves the delimiters after a masked value in place", () => {
    // Found by arbitra's audit of itself (October 19, 2026): the masked value took a statement's semicolon, a
    // closing brace and the rest of a query string with it.
    for (const [line, masked] of [
      ["token=abcdefghijklmnop;", "token=[REDACTED:assigned_secret];"],
      ["const grant = { token: abcdefghijklmnop1};", "const grant = { token: [REDACTED:assigned_secret]};"],
      ["connect(password=hunter2isNotSecret, retries=3)", "connect(password=[REDACTED:assigned_secret], retries=3)"],
      ["password = getSecretV2(x);", "password = [REDACTED:assigned_secret];"],
      ["https://example.test/cb?token=abcdefghijklmnop&next=/home", "https://example.test/cb?token=[REDACTED:assigned_secret]&next=/home"],
      ["https://example.test/cb?token=abcdefghijklmnop&api_key=hunter2isNotSecret", "https://example.test/cb?token=[REDACTED:assigned_secret]&api_key=[REDACTED:assigned_secret]"],
      // A cut that would leave too little to be a secret masks the whole value, as before.
      ["https://example.test/cb?token=abc&next=/home", "https://example.test/cb?token=[REDACTED:assigned_secret]"],
      ["password=abcdefghijk);", "password=[REDACTED:assigned_secret];"],
    ] as const) {
      expect(redactSecrets(line).text).toBe(masked);
      expect(redactSecrets(masked)).toMatchObject({ text: masked, redactions: [] });
    }
  });

  it("masks in time linear in the text, however its values nest or end", () => {
    // A value left in place is scanned again from its start: unbounded, 1 MB of nested calls took 137 s.
    for (const text of ["token=f(".repeat(25_000), `token=${"a".repeat(300)}${"\\".repeat(200_000)}x`, JSON.stringify("token=abcdefghijklmnop\n".repeat(10_000))]) {
      const started = performance.now();
      redactSecrets(text);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
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
