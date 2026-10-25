import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  /** The models the CLI says this account can use, where it can list them (Antigravity's `agy models`). */
  readonly models?: readonly { readonly id: string; readonly name: string }[];
  /** What the vendor's own terms say about driving this CLI from another application, when they restrict it. */
  readonly caution?: string;
}

/**
 * Google's Antigravity FAQ (read October 22, 2026): wrapping `agy` inside third-party applications "is not supported
 * under consumer plans", and its terms call accessing the service through third-party software a breach that "may be
 * grounds for suspension". Google points such tools to a Gemini API key instead.
 */
export const ANTIGRAVITY_CAUTION = "Google's terms: running agy inside another application is not supported on Google AI Pro or Ultra plans and may get the account suspended. Google's supported route for tools like arbitra is a Gemini API key (Google AI Studio).";
export interface DetectedEnvironment {
  readonly checkedAt: string;
  readonly platform: string;
  readonly node: string;
  readonly clis: readonly DetectedCli[];
  /** Which API keys are set in arbitra's environment; never their values. */
  readonly apiKeys: Readonly<Record<string, boolean>>;
}

/**
 * The arbitra build this process runs, as the diagnostics and a run's recorded versions name it: ARBITRA_BUILD (the
 * single-file app names its release there), else the short Git commit of the checkout at `root`, else the commit Git
 * wrote into tooling/launch/build-id when it made a download's archive. Null when none of them says.
 */
export function arbitraBuild(root: string): string | null {
  const named = process.env["ARBITRA_BUILD"];
  if (named !== undefined) return named;
  try { return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch {
    try { const id = readFileSync(join(root, "tooling", "launch", "build-id"), "utf8").trim(); return id.startsWith("$Format") ? null : `${id}, from a download`; }
    catch { return null; }
  }
}

export type ModelLister = (transport: string, executable: string) => Promise<readonly { readonly id: string; readonly name: string }[] | null>;

/** `agy models` prints one model a line, its ID and name split by a tab; it makes no model call. Other CLIs list none. */
const cliModels: ModelLister = (transport, executable) => transport !== "antigravity-cli" ? Promise.resolve(null) : new Promise((resolve) => {
  execFile(executable, ["models"], { encoding: "utf8", windowsHide: true, timeout: 20_000 }, (error, stdout) => {
    if (error !== null) { resolve(null); return; }
    resolve(stdout.split(/\r?\n/u).map((line) => line.split("\t")).filter((parts): parts is [string, string] => parts.length >= 2 && /^[\w.-]+$/u.test(parts[0] ?? ""))
      .map(([id, name]) => ({ id, name: name.trim() })));
  });
});

const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/**
 * What models this machine can run without a model call: each subscription CLI arbitra drives (found, version,
 * signed in) and which API keys are set. The New run page shows it, and the run report includes it.
 */
export async function detectEnvironment(lookup: (name: string) => string | undefined = (name) => process.env[name], probe: CliProbe = probeCliReadiness, listModels: ModelLister = cliModels): Promise<DetectedEnvironment> {
  // The Gemini CLI is left out: Google retired personal logins from it, so a tester could not use it anyway.
  const clis = await Promise.all(CLI_TRANSPORT_SUPPORT.filter(({ transport }) => transport !== "gemini-cli").map(async (support): Promise<DetectedCli> => {
    const readiness = await probe(support.transport, { lookup, auth: "subscription_login", oauthTokenEnv: null }).catch(() => null);
    const base = { transport: support.transport, name: support.displayName, ...(support.transport === "antigravity-cli" ? { caution: ANTIGRAVITY_CAUTION } : {}) };
    if (readiness === null || !readiness.executable.found) return { ...base, path: null, version: null, state: "not_installed", note: "not found", fix: support.installInstruction };
    const path = readiness.executable.executable.path;
    if (readiness.versionSupported !== true) return { ...base, path, version: readiness.version, state: "unsupported_version", note: `version ${readiness.version ?? "unreadable"}; arbitra needs ${support.versionRange.minimum} to below ${support.versionRange.below}`, fix: support.installInstruction };
    if (readiness.auth === "not_logged_in") return { ...base, path, version: readiness.version, state: "not_signed_in", note: "not signed in", fix: support.loginInstruction };
    if (readiness.auth === "api_key_login") return { ...base, path, version: readiness.version, state: "api_key_login", note: "signed in with an API key, which would spend API credit", fix: support.loginInstruction };
    const limit = readiness.usageLimit === null ? "" : ` · usage limit reached recently`;
    const models = await listModels(support.transport, path).catch(() => null);
    return { ...base, path, version: readiness.version, state: "ready", note: `${readiness.auth === "logged_in" ? "signed in" : "sign-in confirmed by the first call"}${readiness.authDetail !== null && readiness.auth === "logged_in" ? ` (${readiness.authDetail})` : ""}${limit}`, fix: null, ...(models === null ? {} : { models }) };
  }));
  return Object.freeze({ checkedAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version, clis: Object.freeze(clis),
    apiKeys: Object.freeze(Object.fromEntries(API_KEYS.map((name) => [name, (lookup(name) ?? "") !== ""]))) });
}
