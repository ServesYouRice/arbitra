import { TransportError } from "../../transport-contract.js";
import type { CliTransportSupport } from "./support.js";

/**
 * Maps a CLI's own failure text to the shared error classes. A plan's usage allowance
 * exhausted until a reset is QUOTA (retrying before the reset cannot help); a short
 * throttle or overload is RATE_LIMIT with the CLI's retry hint when it gives one.
 */
export function classifyCliFailure(support: CliTransportSupport, text: string, exitCode: number | null, now = Date.now()): TransportError {
  const detail = cliFailureDetail(text);
  const suffix = detail === "" ? "" : `: ${detail}`;
  if (support.vendor === "gemini" && exitCode === 41 || AUTH_PATTERN.test(text)) {
    const ineligible = /IneligibleTier|no longer supported for Gemini Code Assist|UNSUPPORTED_CLIENT/iu.test(text);
    if (ineligible) return new TransportError("AUTH", `CLI_ACCOUNT_INELIGIBLE: the signed-in Google account's Gemini Code Assist tier no longer serves ${support.displayName}. Sign in with an account whose plan includes Gemini CLI use (for a Workspace or Standard license also export GOOGLE_CLOUD_PROJECT), or bind this role to another endpoint${suffix}`, false);
    return new TransportError("AUTH", `CLI_NOT_LOGGED_IN: ${support.displayName} is not signed in to a subscription. ${support.loginInstruction}${suffix}`, false);
  }
  if (MODEL_PATTERN.test(text)) return new TransportError("INVALID_REQUEST", `CLI_MODEL_UNAVAILABLE: ${support.displayName} refused the configured model for this subscription${suffix}`, false);
  if (OUTPUT_LIMIT_PATTERN.test(text)) return new TransportError("OUTPUT_LIMIT", `MODEL_OUTPUT_LIMIT_REACHED: ${support.displayName} stopped at the output ceiling${suffix}`, false);
  if (QUOTA_PATTERN.test(text)) {
    const reset = resetTime(text, now);
    return new TransportError("QUOTA", `CLI_USAGE_LIMIT_REACHED: the ${support.displayName} subscription's usage allowance is exhausted${reset === null ? "" : ` until ${new Date(reset).toISOString()}`}${suffix}`, false, reset === null ? null : Math.max(0, reset - now));
  }
  if (RATE_PATTERN.test(text)) return new TransportError("RATE_LIMIT", `CLI_RATE_LIMITED: ${support.displayName} was throttled${suffix}`, true, retryHint(text));
  if (/\bAPI Error: 5\d\d|\b5\d\d\b.*(?:Internal|Service Unavailable|Bad Gateway)|stream disconnected|ECONNRESET|ETIMEDOUT|ENOTFOUND|network error/iu.test(text)) {
    return new TransportError("HTTP", `CLI_UPSTREAM_ERROR: ${support.displayName} could not reach its service${suffix}`, true);
  }
  return new TransportError("HTTP", `CLI_FAILED: ${support.displayName} exited ${exitCode === null ? "without a status" : `with status ${exitCode}`}${suffix}`, false);
}

const AUTH_PATTERN = /not logged in|please (?:run )?\/?login|run `?(?:claude|codex) (?:auth )?login|invalid api key|oauth token (?:has )?expired|authentication_error|401 Unauthorized|refresh token|token_expired|Please set an Auth method|Error authenticating|Authentication cancelled|IneligibleTier|no longer supported for Gemini Code Assist|Login with Google/iu;
const MODEL_PATTERN = /model is not supported when using|model_not_found|model[^\n]{0,80}(?:does not exist|not found|is not available|not supported)|invalid model|unknown model/iu;
const OUTPUT_LIMIT_PATTERN = /exceeded the \d+ output token maximum|max_output_tokens|Output token limit hit/iu;
const QUOTA_PATTERN = /usage limit|hit your (?:usage )?limit|limit reached|out of (?:extra )?usage|exhausted your (?:daily )?quota|quota exceeded[^\n]*per ?day|daily (?:request )?limit|weekly limit|credit balance/iu;
const RATE_PATTERN = /rate[ _-]?limit|too many requests|\b429\b|RESOURCE_EXHAUSTED|overloaded|\b529\b/iu;

/** Bounded single-line failure text with anything credential-shaped removed. */
export function cliFailureDetail(text: string): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "" && !/^at\s/u.test(line) && !line.startsWith("{") && !/^Warning: 256-color/u.test(line));
  const relevant = lines.find((line) => MODEL_PATTERN.test(line) || AUTH_PATTERN.test(line) || QUOTA_PATTERN.test(line) || RATE_PATTERN.test(line) || OUTPUT_LIMIT_PATTERN.test(line)) ?? lines[lines.length - 1] ?? "";
  return relevant.replace(/(sk-(?:ant-[a-z0-9]+-|proj-)?|AIza|ya29\.|eyJ)[A-Za-z0-9_.*-]{6,}/gu, "$1<redacted>")
    .replace(/\b(key|token|secret|code)=[^\s&]+/giu, "$1=<redacted>").replace(/[\w.+-]+@[\w-]+\.[\w.]+/gu, "<email>").slice(0, 300);
}

/** "try again in 2 hours 5 minutes", "retry in 23.5s", "retry after 30 seconds". */
export function retryHint(text: string): number | null {
  const match = /(?:try again|retry)(?: after| in)\s+([\d.]+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)\b(?:[\s,and]+[\d.]+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?|d|days?)\b)*)/iu.exec(text);
  if (match?.[1] === undefined) return null;
  let total = 0;
  for (const part of match[1].matchAll(/([\d.]+)\s*([a-z]+)/giu)) {
    const value = Number(part[1]); const unit = (part[2] ?? "").toLowerCase();
    if (!Number.isFinite(value)) return null;
    total += value * (unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000);
  }
  return total > 0 ? Math.ceil(total) : null;
}

/** When a plan allowance resets: a relative hint, an epoch (`limit reached|1758900000`), or an ISO time. */
export function resetTime(text: string, now: number): number | null {
  const epoch = /\|(\d{10})\b/u.exec(text)?.[1] ?? /resets?(?:_?at)?["':\s]+(\d{10})\b/iu.exec(text)?.[1];
  if (epoch !== undefined) return Number(epoch) * 1_000;
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/u.exec(text)?.[1];
  if (iso !== undefined && Number.isFinite(Date.parse(iso))) return Date.parse(iso);
  const relative = retryHint(text);
  return relative === null ? null : now + relative;
}
