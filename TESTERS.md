# Trying arbitra

arbitra audits a code project with several AI models at once, has them check each other's findings against the
code, and writes a plan to fix what holds up. It runs on your own computer and uses the AI subscriptions you
already have. It never changes your code.

## What you need

- Windows, macOS or Linux, and an internet connection.
- On Windows, nothing else if you use the `.exe` below. Otherwise **Node.js 22.13 or newer** (<https://nodejs.org>;
  any current or LTS version); arbitra sets up the rest itself.
- At least one of these, installed and signed in with your subscription:
  - **Claude Code** (Claude Pro or Max): <https://docs.claude.com/en/docs/claude-code>. The copy inside the VS Code
    extension works too.
  - **Codex CLI** (ChatGPT Plus or Pro): `npm install -g @openai/codex`, then `codex login` and choose Sign in with
    ChatGPT.
  - Optional, **Antigravity CLI** (Google AI plan): run `agy` once and sign in. Google's terms say using `agy` inside
    another application is not supported on Google AI Pro or Ultra and may get the account suspended, so arbitra
    leaves Gemini out unless you choose the template that adds it.

  The default uses Claude Code and Codex together; one is enough to try it. Your code is sent to the vendors you choose
  and to no one else: [what leaves your machine](docs/privacy.md).

## Start it

**Windows, the easy way:** download **`arbitra-<version>-windows.exe`** from the latest release,
<https://github.com/ServesYouRice/arbitra/releases/latest>, and double-click it. It is not signed, so Windows warns
first: choose **More info**, then **Run anyway**. It needs no Node.js and builds nothing; it opens arbitra in your
browser and keeps your runs in `%LOCALAPPDATA%\arbitra`. Keep its window open while you use arbitra; closing it stops
arbitra. Then go on at [Run an audit](#run-an-audit).

**Any system, from the zip:**

1. Download the zip from the latest release, <https://github.com/ServesYouRice/arbitra/releases/latest>, and unzip it
   anywhere.
2. Start it:
   - **Windows:** double-click **`arbitra.cmd`**. If Windows asks whether to run it, choose **Run** (or **More info**,
     then **Run anyway**).
   - **macOS:** open **Terminal**, type `bash ` (with a space), drag **`arbitra.command`** from the folder into the
     Terminal window, and press Return. (Double-clicking it also works once macOS allows it, but a downloaded file is
     blocked at first as "from an unidentified developer".)
   - **Linux:** run `./arbitra.command`.

   The first start installs and builds arbitra and takes a few minutes; later starts take seconds. Keep the window
   open while you use arbitra; closing it stops arbitra.
3. Your browser opens on arbitra. If it does not, open <http://127.0.0.1:4178>.

## Run an audit

1. Click **New run**. Under **Models**, check that the tools you have show as **ready**; if one does not, the line
   says what to do.
2. New run opens on two auditors on the subscription CLIs with the recommended models and settings: Opus 5.5 and
   GPT-6.1 Sol audit at xhigh; Opus then checks each issue the plan acts on against the code (a severe issue it
   rejects is asked of a second model) and writes the plan, and Sol reviews it. The auditors do not review each
   other's findings: in our tests that round cost about 40% of the tokens and added one or two issues. You can pick
   another model for each from its list. To add Gemini as a third auditor, choose **Audit · Claude, GPT and Gemini**
   under **starting point** (read Google's terms above first).
3. Next to **repository path**, click **browse…** and choose the project folder you want audited (or paste its path).
4. Click **check configuration**, then **save and start**. The check measures the project and sets the run's token
   limit for its size. With Gemini added, a project of 11,700 lines took 40 minutes and 7.5 million tokens, and one
   of 39,000 lines took 105 minutes and 27 million (about a third of a Claude Max 20x five-hour window, most of the
   tokens being Claude's); without Gemini a run uses somewhat less. Start with a small project and mind your plans'
   usage.
5. When it finishes, the run page leads with **the plan**: **save the plan into the project as prompts** writes a
   `.arbitra/plans/` folder into your project. It has one ready-to-paste prompt per fix, sorted by the kind of model
   each suits, and an `AGENTS.md` a coding agent follows: open the project in Claude Code or Codex and ask it to
   work through `.arbitra/plans/<folder>`. Answer the questions its README lists first: they are decisions only you
   can make. Issues the models could not settle get a prompt of their own under `prompts/0-check-first`, which asks
   a strong model to decide whether the defect is real and fix it if it is. Each prompt asks for a test that fails
   before the fix, and the agent records each issue's result in `results.json`; the run's report and **Evaluation**
   tab then show how many defects a failing test proved and how many were fixed. The **Issues** tab lists everything
   found, including the smaller issues the plan leaves out, and how each was checked.

## If something goes wrong

If a run pauses at its token limit, its page offers **raise to … and resume**: it goes on from where it stopped and
keeps everything it has done. If a run reaches a usage limit of one of your plans, it pauses and keeps everything too;
when the plan says when the limit resets, arbitra resumes the run by itself a minute later while it stays open.
Otherwise resume it from the run's page once the limit has reset.

On the run's page, open **report to send**, click **copy**, and send the text to whoever gave you arbitra. It holds
no source code and no secrets: the app's version, your system, which tools it found, the run's settings and any
errors. If arbitra does not start at all, copy the lines in its window instead.
