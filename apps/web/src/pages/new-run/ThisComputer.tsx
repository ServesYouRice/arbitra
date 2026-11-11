import type { ReactElement } from "react";
import type { ApiKeyCheck } from "../../api/runs.js";
import type { OfferedModels } from "./model-catalog.js";
import { codexWords, type WindowsState } from "./windows.js";

export interface DetectedCli { readonly transport: string; readonly name: string; readonly state: string; readonly version: string | null; readonly note: string; readonly fix: string | null; readonly path?: string | null; readonly models?: readonly { readonly id: string; readonly name: string }[]; readonly caution?: string; readonly others?: readonly { readonly path: string; readonly version: string | null }[] }
/** Whether a run keeps this computer awake (`held`, `ready`), or why not (`unavailable`, `failed`); null from an arbitra that holds nothing. */
export interface KeepAwakeState { readonly state: "held" | "ready" | "unavailable" | "failed"; readonly tool: string | null; readonly detail: string }
export interface DetectedEnvironment { readonly build: string; readonly checkedAt?: string; readonly clis: readonly DetectedCli[]; readonly apiKeys: Readonly<Record<string, boolean>>; readonly keepAwake?: KeepAwakeState | null }

/** The models this machine can run, found without a model call: the lists the CLIs give (only Antigravity gives one). */
export function offeredModels(environment: DetectedEnvironment | null): OfferedModels {
  return Object.fromEntries((environment?.clis ?? []).flatMap(({ transport, models }) => models === undefined ? [] : [[transport, models]]));
}

/** Whether Antigravity, the third finder's CLI, is on this computer and signed in. */
export function antigravityState(environment: DetectedEnvironment | null): "ready" | "missing" | "unknown" {
  const cli = environment?.clis.find(({ transport }) => transport === "antigravity-cli");
  return environment === null ? "unknown" : cli?.state === "ready" ? "ready" : "missing";
}

/** The CLIs the lineup uses that are not ready on this computer, and why, in words: what Start needs first. */
export function missingClis(environment: DetectedEnvironment | null, transports: ReadonlySet<string>): readonly { readonly name: string; readonly state: string }[] {
  return (environment?.clis ?? []).filter(({ transport, state }) => transports.has(transport) && state !== "ready").map(({ name, state }) => ({ name, state: state.replaceAll("_", " ") }));
}

/**
 * Whether a run keeps this computer from sleeping. A missing tool or a holder that stopped shows here, never as a failed
 * run; a run across a sleep still goes on (its calls are sent again once the computer is awake).
 */
function KeepAwakeRow({ state }: { readonly state: KeepAwakeState | null }): ReactElement | null {
  if (state === null) return null;
  const kept = state.state === "held" || state.state === "ready";
  return <tr data-ready={kept}><th scope="row">Sleep</th><td className="state" data-state={kept ? "verified" : "degraded"}>{state.detail}</td><td>{state.state === "held" ? "a run is working now" : ""}</td><td /></tr>;
}

/**
 * What a signed-in CLI's usage windows say now. Codex's are read in the background without a model call; Claude Code
 * shows its own only in a model call, which arbitra does not make for this, so they are not read. A window that could
 * not be read says "not read" and nothing more: it is not a problem with the computer.
 */
function UsageRows({ environment, windows }: { readonly environment: DetectedEnvironment; readonly windows: WindowsState }): ReactElement | null {
  const ready = (transport: string) => environment.clis.some((cli) => cli.transport === transport && cli.state === "ready");
  const codex = windows === "loading" ? "reading…" : windows === "failed" ? null : codexWords(windows);
  return <>
    {ready("codex-cli") ? <tr><th scope="row">Codex usage</th><td className="state" colSpan={3} data-state={windows === "loading" ? "unexamined" : codex === null ? "degraded" : "verified"}>{codex ?? "not read"}</td></tr> : null}
    {ready("claude-code-cli") ? <tr><th scope="row">Claude Code usage</th><td className="state" colSpan={3} data-state="degraded">not read: Claude Code shows its windows only in a model call</td></tr> : null}
  </>;
}

/** What the provider said of a key, in words: accepted and which models it knows, refused, not set, or not checked. */
export function keyWords(check: ApiKeyCheck): { readonly words: string; readonly state: "verified" | "refuted" | "degraded" } {
  const unknown = check.models.filter(({ known }) => known === false).map(({ modelId }) => modelId);
  const known = check.models.filter(({ known: is }) => is === true).map(({ modelId }) => modelId);
  if (check.state === "missing") return { words: `${check.variable} is not set`, state: "refuted" };
  if (check.state === "refused") return { words: `refused by ${check.providerId}${check.detail === null ? "" : `: ${check.detail}`}`, state: "refuted" };
  if (check.state === "unchecked") return { words: `not checked${check.detail === null ? "" : ` (${check.detail})`}; the first call tells`, state: "degraded" };
  if (unknown.length > 0) return { words: `accepted by ${check.providerId}, which has no model ${unknown.join(", ")}`, state: "refuted" };
  return { words: `accepted by ${check.providerId}${known.length === 0 ? "" : `, which knows ${known.join(", ")}`}`, state: "verified" };
}

/** One row per API key the lineup reads, from the last check; before a check, where the keys are read from. */
function KeyRows({ keyVariables, keyChecks }: { readonly keyVariables: readonly string[]; readonly keyChecks: readonly ApiKeyCheck[] | null }): ReactElement | null {
  if (keyVariables.length === 0) return null;
  if (keyChecks === null || keyChecks.length === 0) return <tr><th scope="row">API keys</th><td>read from {keyVariables.join(", ")}; the check says if one is not set or not accepted</td><td /><td>in this lineup</td></tr>;
  return <>{keyChecks.map((check) => {
    const { words, state } = keyWords(check);
    return <tr data-ready={state === "verified"} key={check.endpointId}>
      <th scope="row">API key {check.variable}</th>
      <td className="state" data-state={state}>{words}</td>
      <td>{check.cost === "models_route" ? "asked without a model call" : ""}</td>
      <td>in this lineup</td>
    </tr>;
  })}</>;
}

/**
 * This computer: one row per CLI arbitra looked for, with its version, whether it is signed in, what it offers and
 * whether the lineup uses it. How to install one that is missing, where each was found, and how models are found and
 * chosen are each one click down.
 */
export function ThisComputer({ environment, failure, transports, keyVariables, keyChecks = null, subscription, windows = "loading" }: { readonly environment: DetectedEnvironment | null; readonly failure: string | null; readonly transports: ReadonlySet<string>; readonly keyVariables: readonly string[]; readonly keyChecks?: readonly ApiKeyCheck[] | null; readonly subscription: boolean; readonly windows?: WindowsState }): ReactElement {
  return <div className="computer">
    {failure !== null ? <p className="state" data-state="degraded">The CLIs on this computer could not be checked · {failure}</p>
      : environment === null ? <p className="state" data-state="unexamined" role="status">Looking for the CLIs on this computer</p>
      : <div className="table-scroll"><table aria-label="CLIs on this computer" className="table computer-table"><tbody>{environment.clis.map((cli) => {
        const used = transports.has(cli.transport);
        const gemini = (cli.models ?? []).filter(({ id }) => /gemini|argon/iu.test(id));
        return <tr data-ready={cli.state === "ready"} data-used={used} key={cli.name}>
          <th scope="row">{cli.name}{cli.version === null ? "" : ` ${cli.version}`}</th>
          <td className="state" data-state={cli.state === "ready" ? "verified" : used ? "refuted" : "degraded"}>{cli.state === "ready" ? cli.note : cli.state.replaceAll("_", " ")}
            {cli.fix === null ? null : <details className="fold"><summary>how to fix</summary><span className="field__hint">{cli.fix}</span></details>}</td>
          <td>{gemini.length === 0 ? "" : `offers ${gemini.map(({ name }) => name).join(", ")}`}</td>
          <td className={used ? undefined : "muted"}>{used ? "in this lineup" : "not in this lineup"}</td>
        </tr>;
      })}<KeyRows keyVariables={keyVariables} keyChecks={keyChecks} />
        <UsageRows environment={environment} windows={windows} />
        <KeepAwakeRow state={environment.keepAwake ?? null} /></tbody></table></div>}
    {environment === null ? null : <details className="fold">
      <summary>Where each was found, and how models are found and chosen</summary>
      <ul className="plain-list computer-paths">{environment.clis.filter(({ path }) => typeof path === "string").map(({ name, path, others }) => <li key={name}>{name} · <code>{path}</code>{(others ?? []).map((other) => <span key={other.path}>; also {other.version ?? "a version it did not report"} at <code>{other.path}</code>, not used</span>)}</li>)}</ul>
      <p className="note">arbitra asks each CLI on this computer for its version and whether it is signed in; no model is called. Each API key goes only to its own provider, which is asked on its models list whether it takes the key and knows each model; that is not a model call and costs nothing, and it cannot tell whether the account has credit. Of several copies of one CLI it uses the newest it supports: an older copy, such as the one inside the ChatGPT app, may not know the newest models. Claude Code and Codex do not list their models, so their choices are the models arbitra knows to work through them. Antigravity lists the models your account can use, and only its Gemini models are offered, so a third finder stays independent of Claude and GPT.</p>
      <p className="note">{subscription ? "Each card names the model and effort of every step, in the CLI's own effort word; the steps below change any of them. Opus 5.5 always checks the critical and high issues; Gemini only ever does optional work." : "This lineup names its own models; the steps below and Change models pick others."} The usage windows (five-hour, weekly) are what the vendor's own meter says now, read without a model call; arbitra does not know your plan, so the warning under the estimate is from what was measured on one.</p>
    </details>}
  </div>;
}
