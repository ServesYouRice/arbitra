import { describe, expect, it } from "vitest";
import { nativeHarnessConfigSchema } from "../src/native-harness.js";

const bounds = { harnessId: "claude-code", stages: ["testing-writer"], timeoutMs: 600_000, maximumTurns: 20, maximumToolCalls: 40, maximumTokensPerRun: 400_000 };

describe("native harness configuration", () => {
  it("accepts a credential variable, a subscription token or the host's own login, with no defaulted kind", () => {
    expect(nativeHarnessConfigSchema.parse({ ...bounds, apiKeyEnvVar: "ARBITRA_CLAUDE_CODE_API_KEY" })).toEqual({ ...bounds, apiKeyEnvVar: "ARBITRA_CLAUDE_CODE_API_KEY" });
    expect(nativeHarnessConfigSchema.parse({ ...bounds, apiKeyEnvVar: "CLAUDE_TOKEN", credentialKind: "oauth_token" }).credentialKind).toBe("oauth_token");
    expect(nativeHarnessConfigSchema.parse({ ...bounds, credentialKind: "subscription_login" })).toEqual({ ...bounds, credentialKind: "subscription_login" });
    // Presence rules per kind are preflight diagnostics, so the schema admits both shapes.
    expect(nativeHarnessConfigSchema.safeParse(bounds).success).toBe(true);
    expect(nativeHarnessConfigSchema.safeParse({ ...bounds, apiKeyEnvVar: "KEY", credentialKind: "subscription_login" }).success).toBe(true);
  });

  it("rejects unknown credential kinds and literal secrets in place of a variable name", () => {
    expect(nativeHarnessConfigSchema.safeParse({ ...bounds, credentialKind: "keychain" }).success).toBe(false);
    expect(nativeHarnessConfigSchema.safeParse({ ...bounds, apiKeyEnvVar: "sk-ant-literal-secret" }).success).toBe(false);
    expect(nativeHarnessConfigSchema.safeParse({ ...bounds, credentialKind: "subscription_login", apiKeyEnvVarr: "KEY" }).success).toBe(false);
  });
});
