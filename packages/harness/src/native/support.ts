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
export function assertNativeHarnessSupported(harnessId: string, version: string, stage: string): NativeHarnessSupport {
  const support = nativeHarnessSupport(harnessId);
  if (!(support.stages as readonly string[]).includes(stage)) throw new Error(`NATIVE_HARNESS_STAGE_UNSUPPORTED:${harnessId}:${stage}`);
  if (!versionInRange(version, support.versionRange)) throw new Error(`NATIVE_HARNESS_VERSION_UNSUPPORTED:${harnessId}@${version}`);
  return support;
}

/** Tools must be individually permitted; shell, network, subagent, MCP and unknown tools cannot be bounded and are refused. */
export function unenforceableNativeTools(support: NativeHarnessSupport, tools: readonly string[]): readonly { readonly tool: string; readonly reason: Exclude<NativeToolClass, "read" | "write"> }[] {
  return tools.flatMap((tool) => {
    const reason = support.classifyTool(tool);
    return reason === "read" || reason === "write" ? [] : [{ tool, reason }];
  });
}

export function parseSemanticVersion(value: string): readonly [number, number, number] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionInRange(version: string, range: { readonly minimum: string; readonly below: string }): boolean {
  const actual = parseSemanticVersion(version); const minimum = parseSemanticVersion(range.minimum); const below = parseSemanticVersion(range.below);
  if (actual === null || minimum === null || below === null) return false;
  return compare(actual, minimum) >= 0 && compare(actual, below) < 0;
}

function compare(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}
