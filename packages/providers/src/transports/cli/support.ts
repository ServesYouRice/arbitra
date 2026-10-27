/**
 * Subscription CLI transports: a vendor's official CLI, run headless as a plain completion
 * engine, so a model role can be served by a Claude, ChatGPT or Google subscription login
 * instead of API credit. arbitra keeps the tool loop, context, budgets and policy; the CLI's
 * own agent tools are disabled and any sign that it used one fails the call.
 *
 * `declared_unverified`: implemented and tested against scripted stand-in executables only.
 * `live_verified`: a recorded live run (see `evidence`) passed on the listed CLI versions.
 */
export type CliVendor = "claude-code" | "codex" | "gemini" | "antigravity";
export type CliTransportId = "claude-code-cli" | "codex-cli" | "gemini-cli" | "antigravity-cli";
export type CliAuthMode = "subscription_login" | "oauth_token";
export type TransportSupportStatus = "declared_unverified" | "live_verified";

export interface CliTransportSupport {
  readonly transport: CliTransportId;
  readonly vendor: CliVendor;
  readonly displayName: string;
  /** The only endpoint form this transport accepts. */
  readonly endpoint: `cli://${CliVendor}`;
  /** Host override naming the absolute executable path. Operator-controlled, never run configuration. */
  readonly executableEnvVar: string;
  /** Command looked up on PATH when the override is unset. */
  readonly command: string;
  /** Inclusive minimum and exclusive upper bound of the CLI's own version; others are refused. */
  readonly versionRange: { readonly minimum: string; readonly below: string };
  readonly status: TransportSupportStatus;
  readonly verifiedVersions: readonly string[];
  readonly evidence: string | null;
  readonly authModes: readonly CliAuthMode[];
  /** What the operator runs, once, to sign in with the subscription. */
  readonly loginInstruction: string;
  readonly installInstruction: string;
  /**
   * The oldest CLI version known to serve a model, recorded where an older one is known not to: a call to that model
   * through an older CLI is refused before anything is sent, and preflight refuses the run.
   */
  readonly modelMinimumVersions?: Readonly<Record<string, string>>;
}

export const CLI_TRANSPORT_SUPPORT: readonly CliTransportSupport[] = Object.freeze([
  Object.freeze({
    transport: "claude-code-cli", vendor: "claude-code", displayName: "Claude Code", endpoint: "cli://claude-code",
    executableEnvVar: "ARBITRA_CLAUDE_CODE_EXECUTABLE", command: "claude",
    versionRange: Object.freeze({ minimum: "2.1.0", below: "3.0.0" }),
    status: "live_verified", verifiedVersions: Object.freeze(["2.1.282", "2.1.296"]), evidence: "docs/qa/subscription-cli/README.md",
    authModes: Object.freeze(["subscription_login", "oauth_token"] as const),
    loginInstruction: "Run `claude auth login` (or start `claude` and use /login) and sign in with your Claude Pro or Max account. For a separate token, run `claude setup-token` and use auth \"oauth_token\".",
    installInstruction: "Install Claude Code (https://docs.claude.com/en/docs/claude-code) so `claude` is on PATH, or set ARBITRA_CLAUDE_CODE_EXECUTABLE to its absolute path.",
  }),
  Object.freeze({
    transport: "codex-cli", vendor: "codex", displayName: "Codex CLI", endpoint: "cli://codex",
    executableEnvVar: "ARBITRA_CODEX_EXECUTABLE", command: "codex",
    versionRange: Object.freeze({ minimum: "0.150.0", below: "0.200.0" }),
    status: "live_verified", verifiedVersions: Object.freeze(["0.154.0", "0.162.1"]), evidence: "docs/qa/subscription-cli/README.md",
    authModes: Object.freeze(["subscription_login"] as const),
    loginInstruction: "Run `codex login` and choose Sign in with ChatGPT. An API-key login is refused here because it would spend API credit.",
    installInstruction: "Install the current Codex CLI (`npm install -g @openai/codex`) so `codex` is on PATH, or set ARBITRA_CODEX_EXECUTABLE to its absolute path. The copy inside the ChatGPT desktop app on macOS is found too, but it can be too old for the newest models.",
    // Observed live (October 26, 2026, macOS): the ChatGPT app's bundled CLI, 0.158.0-alpha.2.1, answered gpt-6.1-sol with
    // model_not_found ("not supported when using Codex with a ChatGPT account"), while the app's own runtime (0.162.0)
    // served it on the same account; so did the CLI at 0.162.1 (Windows, every Sol call of October 25) and 0.164.0.
    modelMinimumVersions: Object.freeze({ "gpt-6.1-sol": "0.162.0" }),
  }),
  Object.freeze({
    transport: "gemini-cli", vendor: "gemini", displayName: "Gemini CLI", endpoint: "cli://gemini",
    executableEnvVar: "ARBITRA_GEMINI_EXECUTABLE", command: "gemini",
    versionRange: Object.freeze({ minimum: "0.60.0", below: "1.0.0" }),
    status: "declared_unverified", verifiedVersions: Object.freeze([]), evidence: "docs/qa/subscription-cli/README.md",
    authModes: Object.freeze(["subscription_login"] as const),
    // Since June 18, 2026 Google serves the Gemini CLI only to Code Assist Standard/Enterprise
    // logins; personal Google accounts (free, AI Pro, AI Ultra) use the Antigravity CLI instead.
    loginInstruction: "Run `gemini` once in a terminal and choose Login with Google using a Gemini Code Assist Standard or Enterprise account (export GOOGLE_CLOUD_PROJECT for it). Personal Google AI subscriptions use the antigravity-cli transport; API-key users use gemini-native.",
    installInstruction: "Install the Gemini CLI (`npm install -g @google/gemini-cli`) so `gemini` is on PATH, or set ARBITRA_GEMINI_EXECUTABLE to its absolute path.",
  }),
  Object.freeze({
    transport: "antigravity-cli", vendor: "antigravity", displayName: "Antigravity CLI", endpoint: "cli://antigravity",
    executableEnvVar: "ARBITRA_ANTIGRAVITY_EXECUTABLE", command: "agy",
    // 1.1.15 added `--input-format stream-json`, which carries the prompt on Windows and Linux.
    versionRange: Object.freeze({ minimum: "1.1.15", below: "2.0.0" }),
    status: "live_verified", verifiedVersions: Object.freeze(["1.2.11", "1.3.3"]), evidence: "docs/qa/subscription-cli/README.md",
    authModes: Object.freeze(["subscription_login"] as const),
    loginInstruction: "Run `agy` once in a terminal and sign in with the Google account that holds your Google AI subscription; the login is kept in the operating system's keyring.",
    installInstruction: "Install the Antigravity CLI (`curl -fsSL https://antigravity.google/cli/install.sh | bash`, or `winget install Google.AntigravityCLI` on Windows) so `agy` is on PATH or in ~/.local/bin, or set ARBITRA_ANTIGRAVITY_EXECUTABLE to its absolute path.",
  }),
] satisfies CliTransportSupport[]);

export function cliTransportSupport(transport: string): CliTransportSupport | undefined {
  return CLI_TRANSPORT_SUPPORT.find((entry) => entry.transport === transport);
}

export function requireCliTransportSupport(key: string): CliTransportSupport {
  const support = CLI_TRANSPORT_SUPPORT.find((entry) => entry.transport === key || entry.vendor === key);
  if (support === undefined) throw new Error(`UNKNOWN_TRANSPORT:${key}`);
  return support;
}

/** The oldest version of this CLI that serves `modelId`, when one is recorded. */
export function cliModelMinimumVersion(support: CliTransportSupport, modelId: string): string | null {
  return support.modelMinimumVersions !== undefined && Object.hasOwn(support.modelMinimumVersions, modelId) ? support.modelMinimumVersions[modelId] ?? null : null;
}

/** Why a call to `modelId` through this CLI is refused before it is sent, and what fixes it. */
export function cliTooOldForModel(support: CliTransportSupport, version: string, path: string, modelId: string, minimum: string): string {
  return `CLI_TOO_OLD_FOR_MODEL: ${support.displayName} ${version} (${path}) does not know ${modelId}, which needs ${minimum} or later. ${support.installInstruction}`;
}

export function isCliEndpoint(endpoint: string): boolean { return endpoint.startsWith("cli:"); }

/** Every shipped transport, API and subscription CLI, with its credential kind and verification status. */
export interface TransportSupportEntry {
  readonly transport: string;
  readonly kind: "http_api" | "subscription_cli";
  readonly credential: "api_key_env" | "subscription_login";
  readonly status: TransportSupportStatus;
  readonly evidence: string | null;
}
export const TRANSPORT_SUPPORT_MATRIX: readonly TransportSupportEntry[] = Object.freeze(([
  { transport: "openai-responses", kind: "http_api", credential: "api_key_env", status: "declared_unverified", evidence: null },
  { transport: "openai-chat", kind: "http_api", credential: "api_key_env", status: "live_verified", evidence: "docs/qa/p03/README.md" },
  { transport: "anthropic-messages", kind: "http_api", credential: "api_key_env", status: "declared_unverified", evidence: null },
  { transport: "gemini-native", kind: "http_api", credential: "api_key_env", status: "live_verified", evidence: "docs/qa/p03/README.md" },
  ...CLI_TRANSPORT_SUPPORT.map(({ transport, status, evidence }) => ({ transport, kind: "subscription_cli" as const, credential: "subscription_login" as const, status, evidence })),
] satisfies TransportSupportEntry[]).map((entry) => Object.freeze(entry)));
