import { z } from "zod";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");

/**
 * Operator settings for `harness.mode: "native"`. Harness, stage and tool names are
 * free text here so that preflight can refuse unsupported values with an actionable
 * diagnostic against the support matrix, instead of a bare schema error. The native
 * executable is never part of run configuration: it is read from the host environment
 * variable the support matrix names.
 */
export const nativeHarnessConfigSchema = z.strictObject({
  harnessId: text,
  /** Stages delegated to the native harness. Every other stage stays canonical. */
  stages: z.array(text).min(1),
  /** Host environment variable whose value is passed to the native process as its only credential. */
  apiKeyEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  /** What that credential is: a provider API key, or a subscription token (Claude Code: `claude setup-token`). */
  credentialKind: z.enum(["api_key", "oauth_token"]).default("api_key"),
  /** Native tool names the writer is granted; omitted means the matrix default. */
  tools: z.array(text).min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  /** Passed to the harness and enforced from its event stream. */
  maximumTurns: z.number().int().min(1).max(200),
  /** Observed tool calls per run; exceeding it stops the process tree. */
  maximumToolCalls: z.number().int().min(1).max(500),
  /** Reserved against the shared run token budget before launch and charged in full when usage is unknown. */
  maximumTokensPerRun: z.number().int().positive(),
  maximumOutputBytes: z.number().int().min(1_024).max(64 * 1024 * 1024).optional(),
});
export type NativeHarnessConfig = z.infer<typeof nativeHarnessConfigSchema>;
