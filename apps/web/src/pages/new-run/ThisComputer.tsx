import type { ReactElement } from "react";
import type { OfferedModels } from "./model-catalog.js";

export interface DetectedCli { readonly transport: string; readonly name: string; readonly state: string; readonly version: string | null; readonly note: string; readonly fix: string | null; readonly path?: string | null; readonly models?: readonly { readonly id: string; readonly name: string }[]; readonly caution?: string }
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

/**
 * This computer: each CLI arbitra found, where, whether it is signed in, what it offers, and whether the lineup uses
 * it; then how models are found and chosen, which the setup did not say before (inventory, October 25, 2026).
 */
export function ThisComputer({ environment, failure, transports, apiKeys, subscription, onRefresh }: { readonly environment: DetectedEnvironment | null; readonly failure: string | null; readonly transports: ReadonlySet<string>; readonly apiKeys: boolean; readonly subscription: boolean; readonly onRefresh: () => void }): ReactElement {
  const checked = environment?.checkedAt === undefined ? null : new Date(environment.checkedAt);
  const keys = Object.entries(environment?.apiKeys ?? {}).filter(([, set]) => set).map(([name]) => name);
  return <div className="computer">
    {failure !== null ? <p className="state" data-state="degraded">The CLIs on this computer could not be checked · {failure}</p>
      : environment === null ? <p className="state" data-state="unexamined" role="status">Looking for the CLIs on this computer</p>
      : <ul aria-label="CLIs on this computer" className="plain-list computer-list">{environment.clis.map((cli) => {
        const used = transports.has(cli.transport);
        const gemini = (cli.models ?? []).filter(({ id }) => /gemini|argon/iu.test(id));
        return <li className="state" data-state={cli.state === "ready" ? used ? "verified" : "unexamined" : used ? "refuted" : "degraded"} key={cli.name}>
          <span className="computer-cli">{cli.name}{cli.version === null ? "" : ` ${cli.version}`} · {cli.state === "ready" ? cli.note : cli.state.replaceAll("_", " ")}{used ? "" : " · not in this lineup"}</span>
          {cli.fix === null ? null : <span className="field__hint"> {cli.fix}</span>}
          {gemini.length === 0 ? null : <span className="field__hint"> Offers {gemini.map(({ name }) => name).join(", ")}.</span>}
          {cli.path === undefined || cli.path === null ? null : <span className="computer-path">found at <code>{cli.path}</code></span>}
        </li>;
      })}{apiKeys ? <li className="state" data-state={keys.length === 0 ? "unexamined" : "verified"}>API keys · {keys.length === 0 ? "none set" : keys.join(", ")}</li> : null}</ul>}
    <div className="actions">
      <button className="button" type="button" onClick={onRefresh}>Check again</button>
      {checked === null ? null : <span className="note">checked at {checked.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
    </div>
    <div className="prose computer-how">
      <p><strong>How models are found.</strong> arbitra asks each CLI on this computer for its version and whether it is signed in; no model is called. Claude Code and Codex do not list their models, so their choices are the models arbitra knows to work through them. Antigravity lists the models your account can use, and only its Gemini models are offered, so a third finder stays independent of Claude and GPT.</p>
      <p><strong>How they are chosen.</strong> {subscription ? "Each card names the model and effort of every step, in the CLI’s own effort word. Opus 5.5 always checks the critical and high issues; Gemini only ever finds issues. Change models picks others." : "This lineup names its own models; Change models picks others. The first model of each list is the one the measured runs used."}</p>
    </div>
  </div>;
}
