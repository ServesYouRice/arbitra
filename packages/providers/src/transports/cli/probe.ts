import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { NativeProcessPort } from "../../process.js";
import { versionInRange } from "../../semver.js";
import { cliFailureDetail } from "./classify.js";
import { resolveCliExecutable, type CliExecutableResolution, type HostLookup } from "./discovery.js";
import { defaultLimitLedgerPath, fileLimitLedger, type CliLimitLedger, type CliUsageLimit } from "./limits.js";
import { cliTransportSupport, type CliAuthMode, type CliTransportSupport } from "./support.js";
import { probeCliVersion, runCliCommand, type CliCommandOptions } from "./transport.js";

/**
 * Model-free readiness of one subscription CLI: installed, supported version, signed in to a
 * subscription (not an API key), and not known to be at its usage limit. Auth is checked with
 * the CLI's own status command where one exists; otherwise it stays "unverified" until the
 * first call.
 */
export type CliAuthState = "logged_in" | "not_logged_in" | "api_key_login" | "unverified";
export interface CliReadiness {
  readonly support: CliTransportSupport;
  readonly executable: CliExecutableResolution;
  readonly version: string | null;
  readonly versionSupported: boolean | null;
  readonly auth: CliAuthState | null;
  readonly authDetail: string | null;
  readonly usageLimit: CliUsageLimit | null;
}
export interface CliProbeOptions {
  readonly lookup: HostLookup;
  readonly auth: CliAuthMode;
  readonly oauthTokenEnv: string | null;
  readonly process?: NativeProcessPort;
  readonly platform?: NodeJS.Platform;
  readonly nodeExecutable?: string;
  readonly limits?: CliLimitLedger | null;
  readonly now?: number;
}
export type CliProbe = (transport: string, options: CliProbeOptions) => Promise<CliReadiness>;

export const probeCliReadiness: CliProbe = async (transport, options) => {
  const support = cliTransportSupport(transport);
  if (support === undefined) throw new Error(`UNKNOWN_TRANSPORT:${transport}`);
  const platform = options.platform ?? process.platform;
  const command: CliCommandOptions = { lookup: options.lookup, process: options.process, platform, nodeExecutable: options.nodeExecutable };
  const ledgerPath = options.limits === undefined ? defaultLimitLedgerPath(options.lookup, platform) : null;
  const ledger = options.limits === undefined ? ledgerPath === null ? null : fileLimitLedger(ledgerPath) : options.limits;
  const usageLimit = await ledger?.current(transport, options.now ?? Date.now()).catch(() => null) ?? null;
  const executable = await resolveCliExecutable(support, { platform, lookup: options.lookup, nodeExecutable: options.nodeExecutable ?? process.execPath });
  if (!executable.found) return Object.freeze({ support, executable, version: null, versionSupported: null, auth: null, authDetail: null, usageLimit });
  const version = await probeCliVersion(executable.executable, support, command).catch(() => null);
  const versionSupported = version === null ? false : versionInRange(version, support.versionRange);
  const { auth, detail } = !versionSupported ? { auth: null, detail: null } : await authState(support, executable, options, command);
  return Object.freeze({ support, executable, version, versionSupported, auth, authDetail: detail, usageLimit });
};

async function authState(support: CliTransportSupport, resolution: CliExecutableResolution, options: CliProbeOptions, command: CliCommandOptions): Promise<{ auth: CliAuthState; detail: string | null }> {
  if (!resolution.found) return { auth: "unverified", detail: null };
  if (options.auth === "oauth_token") {
    const token = options.lookup(options.oauthTokenEnv ?? "");
    return token === undefined || token === "" ? { auth: "not_logged_in", detail: `${options.oauthTokenEnv ?? "the token variable"} is not set` } : { auth: "unverified", detail: "token present; validated on first call" };
  }
  switch (support.vendor) {
    case "claude-code": {
      const result = await runCliCommand(resolution.executable, ["auth", "status", "--json"], command);
      let status: Record<string, unknown> | null = null;
      try { status = JSON.parse(result.stdout) as Record<string, unknown>; } catch { status = null; }
      if (status === null) return { auth: "unverified", detail: cliFailureDetail(`${result.stdout}\n${result.stderr}`) || null };
      if (status["loggedIn"] !== true) return { auth: "not_logged_in", detail: null };
      const method = String(status["authMethod"] ?? "");
      return /api.?key/iu.test(method) ? { auth: "api_key_login", detail: `authMethod ${method.slice(0, 40)}` } : { auth: "logged_in", detail: typeof status["subscriptionType"] === "string" ? `subscription ${status["subscriptionType"].slice(0, 40)}` : null };
    }
    case "codex": {
      const result = await runCliCommand(resolution.executable, ["login", "status"], command);
      const output = `${result.stdout}\n${result.stderr}`;
      if (/logged in using chatgpt/iu.test(output)) return { auth: "logged_in", detail: null };
      if (/logged in using an? api key|api key/iu.test(output) && /logged in/iu.test(output)) return { auth: "api_key_login", detail: null };
      if (/not logged in/iu.test(output) || result.exitCode !== 0) return { auth: "not_logged_in", detail: null };
      return { auth: "unverified", detail: cliFailureDetail(output) || null };
    }
    // The Antigravity CLI keeps its Google login in the OS keyring and has no status command.
    case "antigravity": return { auth: "unverified", detail: "the Google login is kept in the OS keyring and is confirmed by the first call" };
    case "gemini": {
      // Gemini CLI has no status command. The cached Google login and the selected auth type
      // are the only model-free evidence; eligibility is established by the first call.
      const home = options.lookup("HOME") ?? options.lookup("USERPROFILE");
      if (home === undefined) return { auth: "unverified", detail: null };
      const credentials = await stat(join(home, ".gemini", "oauth_creds.json")).then((value) => value.isFile(), () => false);
      let selected: string | null = null;
      try { const settings = JSON.parse(await readFile(join(home, ".gemini", "settings.json"), "utf8")) as { security?: { auth?: { selectedType?: unknown } } }; selected = typeof settings.security?.auth?.selectedType === "string" ? settings.security.auth.selectedType : null; } catch { selected = null; }
      if (selected !== null && /api-key|vertex/iu.test(selected)) return { auth: "api_key_login", detail: `selectedType ${selected.slice(0, 40)}` };
      return credentials ? { auth: "unverified", detail: "Google login cached; eligibility is confirmed by the first call" } : { auth: "not_logged_in", detail: null };
    }
  }
}
