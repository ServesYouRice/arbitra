# What leaves your machine

arbitra has no server, account or telemetry of its own. It runs on your computer, serves its app on
`127.0.0.1` only, and keeps every run in the `.runs` folder next to it. What leaves the machine is what the model
vendors you choose are sent, through their own CLI or API. This page says what that is and how to narrow it.
Checked against the code on October 22, 2026.

## What the models are sent

- **Source files, and only those.** arbitra reads files with a source extension (TypeScript, JavaScript, Python,
  Go, Rust, Java, C and C++, C#, PHP, Ruby, Swift, Kotlin, shell scripts, SQL, HTML, CSS, Vue, Svelte, Astro and
  other languages). It never reads Markdown, JSON, YAML, `.env` files, images or other data. The list is
  `SCANNED_EXTENSIONS` in `packages/runtime/src/repository.ts`.
- **Only files Git tracks or would track.** In a Git project, anything your `.gitignore` covers is left out, and so
  are `node_modules`, build output, coverage and folders whose names start with a dot (except `.github`).
- **Secrets masked first.** Every message to a model passes the secret masker: AWS access keys, `sk-` API keys,
  GitHub tokens, bearer tokens, values assigned to secret-named fields such as `DB_PASSWORD` or `clientSecret`, and
  private keys (masked across the whole file). Saved results are masked the same way. Masking is pattern based: a
  password inside a connection string, or a secret in an unusual shape, can still get through, so keep secrets out
  of source files.
- **Each auditor sees the files of its share of the project**; the verifier sees the lines an issue cites and the
  question about it; the planner sees the confirmed issues and the files they cite.

## Who receives it

Only the vendors of the models in your run. A run on the default lineup sends source to Anthropic (Claude Code),
OpenAI (Codex) and Google (Antigravity). Three ways to send less:

- **One vendor.** Choose models from one vendor for every role in New run. The run then sends your code to one
  company. Two or three vendors find more; one is still a full audit with every planned issue checked.
- **Your own models.** Any OpenAI-compatible endpoint works per role, including one on your own machine (the
  compatible templates in `examples/model-backed/` point at `http://127.0.0.1:8000/v1`). Nothing then leaves the
  machine. No local model has been through a full live run yet, so expect rough edges.
- **A smaller scope.** Audit one folder, or only a diff, instead of the whole repository.

## What the vendors do with it

That depends on your plan with each vendor, not on arbitra. On consumer plans the vendors may train on what you
send unless you turn it off (terms read October 14, 2026):

| Vendor | Consumer plan default | Where to turn it off |
|---|---|---|
| Anthropic (Claude Pro, Max) | used for training when "Help improve Claude" is on, including in Claude Code | claude.ai, Settings, Privacy |
| OpenAI (ChatGPT Plus, Pro) | "we may use your content to train our models"; Codex has its own setting for full environments | ChatGPT, Settings, Data controls: "Improve the model for everyone"; Codex settings |
| Google (Antigravity) | "We use Interactions to evaluate, develop, and improve Google and Alphabet research"; people may review them | Antigravity settings |

API and business plans are not used for training by default at Anthropic and OpenAI; Google's free Gemini API tier
may be, its paid tier is not. Check your own plan's terms before relying on this.

**Google's terms on using Antigravity through arbitra.** Google's FAQ says wrapping `agy` inside third-party
applications "is not supported under consumer plans", and its terms call accessing the service through third-party
software grounds for suspending the account (read October 22, 2026). Google's supported route for a tool like
arbitra is a Gemini API key from Google AI Studio. New run shows this beside the Antigravity CLI.

## What stays on your machine

- Runs, saved configurations and plans: `.runs` in the arbitra folder, and the plan you choose to save in your
  project's `.arbitra/plans/`.
- The vendor CLIs' own conversation logs: arbitra asks Claude Code for no saved session and Codex for an ephemeral
  one unless a call needs a follow-up turn, and deletes each Antigravity conversation after the call.
- The run report you can copy for support holds no source code and no model output, and is masked like the rest.
