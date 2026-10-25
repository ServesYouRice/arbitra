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
    leaves Gemini out unless you add it as a third finder.

  The default uses Claude Code and Codex together; one is enough to try it. API keys work instead of the CLIs
  (Anthropic, OpenAI, Gemini), and any model on an OpenAI-compatible endpoint (Kimi through Moonshot, OpenRouter, a
  server on your computer) can be added as an extra finder. Your code is sent to the vendors you choose and to no one
  else: [what leaves your machine](docs/privacy.md).

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

1. Click **New run**. Near the bottom, **This computer** shows each tool arbitra found and whether it is signed in;
   for one that is missing, **how to fix** says what to do.
2. Under **Project**, click **Browse…** and choose the project folder you want audited (or paste its path). arbitra
   reads it at once and says how many files and lines it will read.
3. Under **How thorough**, pick a depth. Each card names the model and effort of every step:
   - **Deep**, the default: Opus 5.5 and GPT-6.1 Sol find issues at xhigh; Opus checks each issue the plan acts on
     against the code at high (a severe issue it rejects is asked of Sol as well) and writes the plan. It is the
     only depth measured on real projects, so its card shows an estimate from those runs.
   - **Balanced**: the same models at medium effort, with Sonnet 5.5 checking the medium issues.
   - **Cheap**: Sonnet 5.5 and GPT-6 Luna find issues and Sonnet plans; Opus still checks the critical and high ones.

   Balanced and cheap use less of your plans' usage and say "not measured yet". **Models run through** picks your
   CLIs or API keys. **Add a third finder** adds a model that only finds issues: Gemini 3.8 Flash through Antigravity
   (read Google's terms above first), another model Antigravity offers, or one on an OpenAI-compatible endpoint.
4. Under **Steps**, every step shows its model and effort, and you can change either in place (the card then reads
   "changed"; clicking it again resets the step). Steps that can be left out have a tick: **Review round** and
   **Review the plan** are recommended off, with the measured reason one click down, and **Search for variants** is
   new and off.
5. Under **What to read**, untick a folder to leave it out; each shows its share of the estimate. Tests are audited by
   default. Generated, vendored and minified files are left out, each with its reason, and can be ticked back in.
   **What goes into the plan** chooses between medium issues too (the default) and critical and high only, which
   costs less.
6. Click **Start audit**. Next to it the page says whether the run can start and, if not, what is missing. At depth
   deep on the two default finders, a project of 26,100 lines took 71 minutes and 15.8 million tokens, and one of
   103,600 lines about five and a half hours of work and 70 million, most of them Claude's. Start with a small
   project and mind your plans' usage.
7. When it finishes, the run page's Summary leads with **the plan**: **Save the plan into the project** writes a
   `.arbitra/plans/` folder into your project, which Git ignores: it lists every open issue, so keep it out of a public
   repository until they are fixed. Tick the box under it to send the developer the run's report as you save (see
   [If something goes wrong](#if-something-goes-wrong)). The folder has one ready-to-paste prompt per fix, sorted by the kind of model
   each suits, and an `AGENTS.md` a coding agent follows: open the project in Claude Code or Codex and ask it to
   work through `.arbitra/plans/<folder>`. Answer the questions its README lists first: they are decisions only you
   can make. Reports the models could not settle are listed apart, after the tasks, with prompts under
   `prompts/4-unsure` that ask a strong model to decide whether the defect is real and fix it only if a test shows
   it. Most such reports do not hold, so they are optional. Each prompt asks for a test that fails
   before the fix, and the agent records each issue's result in `results.json`; the run's report and **Results**
   tab then show how many defects a failing test proved and how many were fixed. The **Issues** tab lists everything
   found, including the smaller issues the plan leaves out, and how each was checked.

## If something goes wrong

If a run pauses at its token limit, its page offers **Raise to … and resume**: it goes on from where it stopped and
keeps everything it has done. If a run reaches a usage limit of one of your plans, it pauses and keeps everything too;
when the plan says when the limit resets, arbitra resumes the run by itself a minute later while it stays open.
Otherwise resume it from the run's page once the limit has reset.

On the run's Summary, click **Send to the developer**: it opens a GitHub issue filled in with the run's report, which
you submit from your GitHub account (issues there are public). To send it with every plan you save, tick **Also send
the run's report to the developer when I save** under the Save button. The first time, either shows you the exact
text first. It holds no source code and no secrets: the app's version, your system, which tools it found, the run's
settings (with the folders and files it read or left out) and any errors. **Copy a report to send** copies the same
text, to send another way. If arbitra does not start at all, copy the lines in its window instead.

If arbitra opens a page that looks older than this guide, or its window says another arbitra is already running,
close the other arbitra's window: the new one then starts by itself.
