# Trying arbitra

arbitra audits a code project with several AI models at once, has them check each other's findings against the
code, and writes a plan to fix what holds up. It runs on your own computer and uses the AI subscriptions you
already have. It never changes your code.

## What you need

- Windows, macOS or Linux, and an internet connection.
- **Node.js 22 or 24** (<https://nodejs.org>). pnpm comes with it; with Node 25 or later, install pnpm 10 too
  (`npm install -g pnpm@10`).
- At least one of these, installed and signed in with your subscription:
  - **Claude Code** (Claude Pro or Max): <https://docs.claude.com/en/docs/claude-code>. The copy inside the VS Code
    extension works too.
  - **Codex CLI** (ChatGPT Plus or Pro): `npm install -g @openai/codex`, then `codex login` and choose Sign in with
    ChatGPT.
  - **Antigravity CLI** (Google AI plan): run `agy` once and sign in.

  Three vendors give the best results; one is enough to try it.

## Start it

1. Download this folder (or unzip it) anywhere.
2. Double-click **`arbitra.cmd`** on Windows, or **`arbitra.command`** on macOS (on Linux, run `./arbitra.command`).
   The first start installs and builds arbitra and takes a few minutes; later starts take seconds. Keep the window
   open while you use arbitra; closing it stops arbitra.
3. Your browser opens on arbitra. If it does not, open <http://127.0.0.1:4178>.

## Run an audit

1. Click **New run**. Under **Models**, check that the tools you have show as **ready**; if one does not, the line
   says what to do.
2. Click **audit with the subscription CLIs instead**, then **use the recommended models**.
3. In **repository path**, paste the full path of the project folder you want audited.
4. Click **check configuration**, then **save and start**. A run of a mid-sized project takes about an hour and a
   good part of your plans' usage, so start with a small project.
5. When it finishes, the run page leads with **the plan**: **save the plan into the project as prompts** writes a
   `.arbitra/plans/` folder into your project. It has one ready-to-paste prompt per fix, sorted by the kind of model
   each suits, and an `AGENTS.md` a coding agent follows: open the project in Claude Code or Codex and ask it to
   work through `.arbitra/plans/<folder>`. The **Issues** tab lists what was found and how it was checked.

## If something goes wrong

On the run's page, open **report to send**, click **copy**, and send the text to whoever gave you arbitra. It holds
no source code and no secrets: the app's version, your system, which tools it found, the run's settings and any
errors. If arbitra does not start at all, copy the lines in its window instead.
