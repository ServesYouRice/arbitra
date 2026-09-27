import { versionInRange } from "@arbitra/providers/semver.js";
import type { HarnessProfile } from "../profile.js";
import { CLAUDE_CODE_TRANSLATION, claudeCodeToolClass, type NativeToolClass } from "./claude-code/translation.js";

/**
 * The explicit native harness support matrix. A native harness is used only for a
 * (harness, version, stage) triple listed here; everything else is refused before a
 * run exists. Canonical discovery is never in this matrix: native mode is refused for
 * Audit (independent discovery keeps the canonical round-zero baseline).
 */
export type NativeHarnessStage = "testing-writer";
export const NATIVE_HARNESS_STAGES: readonly NativeHarnessStage[] = Object.freeze(["testing-writer"]);

/**
 * `declared_unverified`: implemented and tested against a scripted stand-in executable
 * that emits the documented event stream, but no conformance run against the actual
 * native process has been recorded. `conformance_verified` requires that evidence.
 */
export type NativeSupportStatus = "declared_unverified" | "conformance_verified";

export interface NativeHarnessSupport {
  /** Stable harness identity; traces record it as `native:<harnessId>`. */
  readonly harnessId: string;
  readonly displayName: string;
  /** Inclusive minimum and exclusive upper bound of the native CLI's own version. */
  readonly versionRange: { readonly minimum: string; readonly below: string };
  readonly stages: readonly NativeHarnessStage[];
  readonly status: NativeSupportStatus;
  /** Host environment variable naming the absolute executable path. Operator-controlled, never run configuration. */
  readonly executableEnvVar: string;
  /** Environment variable, inside the native process, that receives the configured credential. */
  readonly credentialTarget: string;
  /** Every variable the operator may choose instead (`credentialKind`); nothing else is ever set. */
  readonly credentialTargets: Readonly<Record<string, string>>;
  /** `credentialKind: "subscription_login"` (the host's own CLI login, no credential variable) needs at least this CLI version. */
  readonly subscriptionLogin: { readonly minimumVersion: string };
  /** Model profile providers this harness can serve. */
  readonly modelProviders: readonly string[];
  readonly translation: { readonly id: string; readonly version: string; readonly verified: boolean };
  readonly defaultTools: readonly string[];
  readonly classifyTool: (name: string) => NativeToolClass;
  readonly profile: HarnessProfile;
}

/**
 * A native writer runs its own tool loop and manages its own context. arbitra enforces
 * policy around it (isolated scratch copy, sanitized environment, tool-event checks,
 * lease-mediated admission), so the harness itself is not trusted to enforce anything.
 */
export const CLAUDE_CODE_TESTING_WRITER_PROFILE: HarnessProfile = Object.freeze({
  id: "native:claude-code", version: CLAUDE_CODE_TRANSLATION.version, kind: "native",
  capabilities: Object.freeze({ readFiles: true, writeFiles: true, shell: false, skills: false, hooks: false, mcp: false, subagents: false, sandbox: false,
    resumableSessions: false, structuredEvents: true, enforcesExternalPolicy: false, managesContextInternally: true, reportsUsage: true }),
  // The harness must reach its own model endpoint ("restricted"); its network tools are refused.
  policy: Object.freeze({ projectInstructions: "disabled", network: "restricted", memory: "none", subagents: false, advisor: false }),
});

export const NATIVE_HARNESS_SUPPORT: readonly NativeHarnessSupport[] = Object.freeze([
  Object.freeze({
    harnessId: "claude-code", displayName: "Claude Code (headless, stream-json)",
    versionRange: Object.freeze({ minimum: "2.0.0", below: "3.0.0" }),
    stages: Object.freeze(["testing-writer"] as const),
    status: "declared_unverified" as const,
    executableEnvVar: "ARBITRA_CLAUDE_CODE_EXECUTABLE",
    credentialTarget: "ANTHROPIC_API_KEY",
    // A Claude subscription is used through a long-lived token from `claude setup-token`.
    credentialTargets: Object.freeze({ api_key: "ANTHROPIC_API_KEY", oauth_token: "CLAUDE_CODE_OAUTH_TOKEN" }),
    // The host login keeps the host home, so its settings and extensions are switched off by `--safe-mode` (A9), which needs 2.1.0.
    subscriptionLogin: Object.freeze({ minimumVersion: "2.1.0" }),
    modelProviders: Object.freeze(["anthropic"]),
    translation: CLAUDE_CODE_TRANSLATION,
    defaultTools: Object.freeze(["Read", "Glob", "Grep", "Edit", "Write"]),
    classifyTool: claudeCodeToolClass,
    profile: CLAUDE_CODE_TESTING_WRITER_PROFILE,
  }),
]);

export function nativeHarnessSupport(harnessId: string): NativeHarnessSupport {
  const support = NATIVE_HARNESS_SUPPORT.find((entry) => entry.harnessId === harnessId);
  if (support === undefined) throw new Error(`NATIVE_HARNESS_UNSUPPORTED:${harnessId}`);
  return support;
}

/** Refuses any version, stage or tool the matrix does not declare. */
export function assertNativeHarnessSupported(harnessId: string, version: string, stage: string, credentialKind = "api_key"): NativeHarnessSupport {
  const support = nativeHarnessSupport(harnessId);
  if (!(support.stages as readonly string[]).includes(stage)) throw new Error(`NATIVE_HARNESS_STAGE_UNSUPPORTED:${harnessId}:${stage}`);
  if (!versionInRange(version, support.versionRange)) throw new Error(`NATIVE_HARNESS_VERSION_UNSUPPORTED:${harnessId}@${version}`);
  if (credentialKind === "subscription_login" && !versionInRange(version, { minimum: support.subscriptionLogin.minimumVersion, below: support.versionRange.below })) {
    throw new Error(`NATIVE_HARNESS_SUBSCRIPTION_LOGIN_VERSION_UNSUPPORTED:${harnessId}@${version}`);
  }
  return support;
}

/** Tools must be individually permitted; shell, network, subagent, MCP and unknown tools cannot be bounded and are refused. */
export function unenforceableNativeTools(support: NativeHarnessSupport, tools: readonly string[]): readonly { readonly tool: string; readonly reason: Exclude<NativeToolClass, "read" | "write"> }[] {
  return tools.flatMap((tool) => {
    const reason = support.classifyTool(tool);
    return reason === "read" || reason === "write" ? [] : [{ tool, reason }];
  });
}

export { parseSemanticVersion, versionInRange } from "@arbitra/providers/semver.js";
