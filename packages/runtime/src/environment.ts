import { probeCliReadiness, type CliProbe } from "@arbitra/providers/transports/cli/probe.js";
import { CLI_TRANSPORT_SUPPORT } from "@arbitra/providers/transports/cli/support.js";

/** One subscription CLI as this machine has it, in words a tester can act on. */
export interface DetectedCli {
  readonly transport: string;
  readonly name: string;
  readonly path: string | null;
  readonly version: string | null;
  /** `ready`: installed, supported and signed in (or sign-in confirmed only by the first call). */
  readonly state: "ready" | "not_installed" | "unsupported_version" | "not_signed_in" | "api_key_login";
  readonly note: string;
  readonly fix: string | null;
}
export interface DetectedEnvironment {
  readonly checkedAt: string;
  readonly platform: string;
  readonly node: string;
  readonly clis: readonly DetectedCli[];
  /** Which API keys are set in arbitra's environment; never their values. */
  readonly apiKeys: Readonly<Record<string, boolean>>;
}

const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/**
 * What models this machine can run without a model call: each subscription CLI arbitra drives (found, version,
 * signed in) and which API keys are set. The New run page shows it, and the run report includes it.
 */
export async function detectEnvironment(lookup: (name: string) => string | undefined = (name) => process.env[name], probe: CliProbe = probeCliReadiness): Promise<DetectedEnvironment> {
  // The Gemini CLI is left out: Google retired personal logins from it, so a tester could not use it anyway.
  const clis = await Promise.all(CLI_TRANSPORT_SUPPORT.filter(({ transport }) => transport !== "gemini-cli").map(async (support): Promise<DetectedCli> => {
    const readiness = await probe(support.transport, { lookup, auth: "subscription_login", oauthTokenEnv: null }).catch(() => null);
    const base = { transport: support.transport, name: support.displayName };
    if (readiness === null || !readiness.executable.found) return { ...base, path: null, version: null, state: "not_installed", note: "not found", fix: support.installInstruction };
    const path = readiness.executable.executable.path;
    if (readiness.versionSupported !== true) return { ...base, path, version: readiness.version, state: "unsupported_version", note: `version ${readiness.version ?? "unreadable"}; arbitra needs ${support.versionRange.minimum} to below ${support.versionRange.below}`, fix: support.installInstruction };
    if (readiness.auth === "not_logged_in") return { ...base, path, version: readiness.version, state: "not_signed_in", note: "not signed in", fix: support.loginInstruction };
    if (readiness.auth === "api_key_login") return { ...base, path, version: readiness.version, state: "api_key_login", note: "signed in with an API key, which would spend API credit", fix: support.loginInstruction };
    const limit = readiness.usageLimit === null ? "" : ` · usage limit reached recently`;
    return { ...base, path, version: readiness.version, state: "ready", note: `${readiness.auth === "logged_in" ? "signed in" : "sign-in confirmed by the first call"}${readiness.authDetail !== null && readiness.auth === "logged_in" ? ` (${readiness.authDetail})` : ""}${limit}`, fix: null };
  }));
  return Object.freeze({ checkedAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version, clis: Object.freeze(clis),
    apiKeys: Object.freeze(Object.fromEntries(API_KEYS.map((name) => [name, (lookup(name) ?? "") !== ""]))) });
}
