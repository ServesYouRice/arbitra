import type { ReactElement } from "react";
import type { OfferedModels } from "./model-catalog.js";

export interface DetectedCli { readonly transport: string; readonly name: string; readonly state: string; readonly version: string | null; readonly note: string; readonly fix: string | null; readonly path?: string | null; readonly models?: readonly { readonly id: string; readonly name: string }[]; readonly caution?: string; readonly others?: readonly { readonly path: string; readonly version: string | null }[] }
export interface DetectedEnvironment { readonly build: string; readonly checkedAt?: string; readonly clis: readonly DetectedCli[]; readonly apiKeys: Readonly<Record<string, boolean>> }

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
 * This computer: one row per CLI arbitra looked for, with its version, whether it is signed in, what it offers and
 * whether the lineup uses it. How to install one that is missing, where each was found, and how models are found and
 * chosen are each one click down.
 */
export function ThisComputer({ environment, failure, transports, keyVariables, subscription }: { readonly environment: DetectedEnvironment | null; readonly failure: string | null; readonly transports: ReadonlySet<string>; readonly keyVariables: readonly string[]; readonly subscription: boolean }): ReactElement {
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
      })}{keyVariables.length === 0 ? null : <tr><th scope="row">API keys</th><td>read from {keyVariables.join(", ")}; the check says if one is not set</td><td /><td>in this lineup</td></tr>}</tbody></table></div>}
    {environment === null ? null : <details className="fold">
      <summary>Where each was found, and how models are found and chosen</summary>
      <ul className="plain-list computer-paths">{environment.clis.filter(({ path }) => typeof path === "string").map(({ name, path, others }) => <li key={name}>{name} · <code>{path}</code>{(others ?? []).map((other) => <span key={other.path}>; also {other.version ?? "a version it did not report"} at <code>{other.path}</code>, not used</span>)}</li>)}</ul>
      <p className="note">arbitra asks each CLI on this computer for its version and whether it is signed in; no model is called. Of several copies of one CLI it uses the newest it supports: an older copy, such as the one inside the ChatGPT app, may not know the newest models. Claude Code and Codex do not list their models, so their choices are the models arbitra knows to work through them. Antigravity lists the models your account can use, and only its Gemini models are offered, so a third finder stays independent of Claude and GPT.</p>
      <p className="note">{subscription ? "Each card names the model and effort of every step, in the CLI's own effort word; the steps below change any of them. Opus 5.5 always checks the critical and high issues; Gemini only ever does optional work." : "This lineup names its own models; the steps below and Change models pick others."} Usage windows (five-hour, weekly) are not shown: arbitra does not know your plan.</p>
    </details>}
  </div>;
}
