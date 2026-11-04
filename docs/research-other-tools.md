# Verified fixes beat clever fixes, every time

The tools that save users the most effort in late 2026 all work the same way. They act on their own, but in a safe copy of the code. They check their own work with the same scanner or test that found the problem. Then they hand the user one small, ready-to-apply result and leave the final click to the user. No tool asks setup questions. They use built-in skip lists, read the repo's existing instruction files, and pick effort levels for you. The numbers vendors publish look great (Bugbot about 80% of flagged bugs resolved, Semgrep 96% agreement), but independent field studies are far lower: **only about 7–43% of AI review comments lead to a code change**, and **agent-written PRs are merged 35–65% of the time versus about 77–79% for human PRs**. For arbitra, this means: let "Fix it for me" touch only verified issues, keep every change in a separate worktree until the user applies it, re-check with the vendors' models plus tests, and measure acceptance yourself rather than borrowing vendor numbers. The biggest traps are agents editing tests to make them pass, line-number IDs that make fixed issues reappear, secrets leaking into public bug reports, and users clicking "accept all" on wrong suggestions.

**How this was researched:** web search only, on 2026-11-04. Many vendor sites (cursor.com, docs.github.com, semgrep.dev, kiro.dev, arxiv.org) could not be opened directly, so **most facts come from search-result snippets, not full-page reads**. Each number below is labelled **Vendor** (the company's own claim), **Indep.** (measured by someone else, often a research paper) or **Unverified** (secondary or unclear source).

## Summary: one row per arbitra feature

| arbitra feature | What the best tools do | Key number | Main pitfall | Do this in arbitra |
|---|---|---|---|---|
| **Fix it for me** | Fix in a sandbox, re-run the scanner/tests, deliver a small diff for the user to apply (Copilot, Bugbot, Snyk, Codex) | Bugbot: over 35% of auto-fixes merged (Vendor); agent PRs 35–65% merged vs ~77–79% human (Indep.) | Agents delete or edit failing tests (ImpossibleBench) | Git worktree per fix; only verified issues; re-check; block test edits; show "unverified" when tests can't run |
| **Just-go setup** | No questions; default skip lists; read CLAUDE.md/AGENTS.md etc.; one default effort level | Bugbot High effort finds 35% more bugs; $1.00–1.50 per run (Vendor) | Hidden cost; case-sensitive file matching misses `claude.md` | Built-in skips shown to user; cheap pass everywhere, deep pass on risky folders; show cost up front |
| **Short summary / top 3** | Fewer, more meaningful comments; rank by agreement across passes + a checker model | Field acceptance 7–43% (Indep.) | Consensus ranking buries a real bug only one model found | Rank by cross-vendor agreement + verifier; keep one slot for a lone verified high-severity issue; never delete filtered items |
| **Suggested answers to plan questions** | Max ~5 questions, multiple choice, "Recommended" option first, "Other" box, answers saved to the spec (Spec Kit, Claude Code, Kiro) | Clarifying questions raise success up to 74% (Indep., simulated users); wrong AI suggestions cut expert accuracy 14 points (Indep., preprint) | "Accept all" is used most by those who over-trust | Ask only where vendor models disagree; keep risky or uncertain questions out of "accept all"; log defaults |
| **Ask your run** | Chat tied to one finding, fed structured evidence (rule, location, code) | Semgrep agreement 96% on real issues but **41% on false alarms** (Vendor) | Answers drift into general model knowledge | Answer only from the run's records, cite `file:line@commit`, label anything else |
| **Auto re-check** | Quick scan of changes on each commit + scheduled full scan; stable content-based IDs | CodeQL incremental "up to 10x" faster (Vendor) | Line-number IDs make every finding below an edit look new | ID = category + file + code snippet; close only if the re-check covered that spot and the code changed |
| **Auto bug report** | Pre-fill version/OS, search for duplicates, user clicks send (VS Code); scrub data locally first (Sentry) | 5,881 real secrets in public GitHub issues studied (Indep.) | Leaking keys, code, paths into a public issue | Draft only; no code or prompts by default; secret scan blocks send; pre-filled `issues/new` link |
| **Run helper** | Save state every step, resume by ID, cap turns and dollars, pause for humans without blocking | Example runaway loop: about $108 in an hour (Unverified) | Retrying the same failing step forever | Code-first state machine; classify each stop; retry only if something changed; two spend caps; frontier model only for judgment calls |

## How far to trust the published numbers

Vendor numbers are measured on output that was already filtered, often graded by an AI. Field studies that ask "did someone actually change the code?" land much lower.

| Claim | Number | Who measured | Notes |
|---|---|---|---|
| Copilot Autofix median fix time | 28 min vs 1.5 h by hand | Vendor, 2024 beta | ([GitHub blog](https://github.blog/news-insights/product-news/secure-code-more-than-three-times-faster-with-copilot-autofix/)) |
| Copilot Autofix fixes "with little or no editing" | about 2/3 | Vendor, 2024 | So about 1/3 need real work ([ITPro](https://www.itpro.com/software/development/found-means-fixed-githubs-new-code-scanning-tool-will-find-and-fix-the-errors-in-your-code)) |
| Bugbot flagged bugs resolved by merge | ~80% | Vendor, graded by AI | Not precision or recall ([Cursor](https://cursor.com/blog/may-2026-bugbot-changes)) |
| Bugbot Autofix changes merged | over 35% | Vendor, Feb 2026 | ([Cursor changelog](https://cursor.com/changelog/02-26-26)) |
| Semgrep triage agreement | 96% on real issues, 41% on false alarms | Vendor, vs its own researchers | ([Semgrep engineering](https://semgrep.dev/blog/2025/building-an-appsec-ai-that-security-researchers-agree-with-96-of-the-time/)) |
| Snyk fix accuracy | ~80% | Vendor, relayed by third parties | No audit found ([AppSec Santa](https://www.appsecsanta.com/snyk)) |
| Atlassian AI comments that led to a change | 38.7% vs 44.5% for humans | Indep.-ish (company studying own tool, ICSE 2026) | Cycle time down 30.8% ([arXiv 2601.01129](https://arxiv.org/pdf/2601.01129v1)) |
| Mozilla / Ubisoft AI comments accepted | 8.1% / 7.2% | Indep. | Bug comments ~5%, refactoring ~18% ([arXiv 2411.07091](https://export.arxiv.org/pdf/2411.07091)) |
| Google comments resolved by ML edits | ~5–8% of all comments | Indep.-ish (Google) | Tuned for precision over coverage ([Google Research](https://research.google/blog/resolving-code-review-comments-with-ml/)) |
| Agent PR merge rates (AIDev, 456K PRs) | Codex 64%, Devin 49%, Copilot 35%; humans ~77–79% | Indep. | ([arXiv 2507.15003](https://arxiv.org/pdf/2507.15003)) |
| Copilot merged PRs that still needed human help | 59.2% | Indep., via summary | ([EmergentMind](https://www.emergentmind.com/papers/2602.00164)) |
| Review-tool precision in benchmarks | roughly 50% precision and recall for the best | Mostly run by competing vendors | "One tool scores 36–51% depending on who tests it" ([gitautoreview](https://gitautoreview.com/blog/ai-code-review-benchmark-2026)) |

**Bottom line:** plan for most suggestions not being used, and track arbitra's own "applied as-is / applied with edits / thrown away" rates per vendor model.

## Fix it for me: sandbox, re-check, then hand over

Every serious tool keeps the fix away from the user's real code until a human approves. Copilot's coding agent can only push to `copilot/*` branches, and its CI waits for a *different* person to approve ([Microsoft Learn](https://learn.microsoft.com/en-us/training/modules/github-copilot-code-agent/2-security-risks-limitations-copilot-code-agent)). Codex turns internet off by default while the agent edits ([OpenAI docs](https://developers.openai.com/codex/cloud/environments)). Claude Security suggests patches but never applies them ([claude.com](https://claude.com/claude-code-security)). Security tools add a self-check. Snyk makes up to five candidate fixes and re-scans each before showing any ([Snyk blog](https://snyk.io/blog/deepcode-ai-vulnerability-autofixing)). Semgrep only auto-fixes issues it judges real ([Semgrep docs](https://semgrep.dev/docs/semgrep-assistant/overview)).

| Lesson | Evidence | arbitra action |
|---|---|---|
| Never edit in place | All vendors use a throwaway copy + human gate | `git worktree` on a new branch; "Apply" is an explicit click |
| Fix only confirmed issues, one per fix | Semgrep, Codex Security confirm first; Bugbot/CodeRabbit keep one fix per comment | Use arbitra's existing verify step; flag diffs touching unrelated files |
| Re-check with the original detector | Snyk, Codex Security re-scan their own patch | Ask the reporting model and other vendors' models: is it gone, is anything new? |
| Prove with a test that fails before and passes after | SWE-bench's standard check | Run the test on the original code too, outside the agent's control |
| Stop test-tampering | Agents cheated ~92% of the time on impossible tasks; a strict prompt cut it to 1% for GPT-5 ([ImpossibleBench](https://www.emergentmind.com/papers/2510.20270)) | Block edits to existing tests, lint configs, CI files, "skip" markers; tell the agent to stop and explain instead |
| Pick by evidence, not model confidence | Snyk 5 candidates; Semgrep confidence = "does it still compile" | Run 2–3 vendors in parallel; rank by checks passed and diff size |
| Be honest when unchecked | Copilot hides fixes that fail syntax/safety checks ([GitHub docs](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts)) | Show logs, before/after verdicts, files touched; say "unverified" plainly |
| Running tests runs the user's code | Copilot firewall does not cover everything ([GitHub docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall)) | Network off while editing; opt-in to run project code |
| Keep a fallback | ~1/3 of one-shot fixes need real editing | Keep "export fix prompt" for big or design-level issues |

## Just-go setup and short summary: smart defaults, few items, nothing hidden

No tool surveyed asks setup questions. CodeRabbit skips `dist/`, `node_modules/` and minified files by default ([CodeRabbit](https://docs.coderabbit.ai/guides/initial-configuration)) and reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and Copilot instruction files automatically, but only with exact capitalisation ([CodeRabbit](https://docs.coderabbit.ai/knowledge-base/code-guidelines)). Bugbot offers Default, High and "Custom" effort, where the user writes in plain words when to go deep. That is the closest match to "Just go" ([Cursor](https://cursor.com/changelog/05-11-26)). CodeRabbit argues users should not pick models at all and routes each task to a model itself ([CodeRabbit blog](https://coderabbit.ai/blog/why-users-shouldnt-choose-their-own-llm-models-choice-is-not-always-good)).

For noise, Bugbot's original design ran 8 passes, kept only bugs found more than once, then let a checker model drop false alarms ([Cursor blog](https://cursor.com/fr/blog/building-bugbot)). Copilot's 2026 redesign aims for "fewer but more meaningful comments" ([GitHub changelog](https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/)). Filtering has a cost, though: aggressive AI filtering also removed real vulnerabilities ([arXiv 2601.22952](https://arxiv.org/html/2601.22952v1)), and practitioners are more upset by missed bugs than by false alarms ([Ami et al.](https://arxiv.org/abs/2307.16325)).

| Do | Why |
|---|---|
| Skip build, dependency, minified, generated and lock files; show the skip list; allow re-include | CodeRabbit default |
| Read all agent instruction files, any capitalisation, scoped to their folder | Avoids CodeRabbit's case trap |
| Cheap pass everywhere, deep pass on risky/central folders; show estimated cost first | Bugbot High finds 35% more at higher cost; ~$1–1.50/run |
| Cheap model for summaries and de-duplication, strong model for finding and checking | CodeRabbit cites a 10–30x price gap ([CodeRabbit](https://www.plushcap.com/content/coderabbit/blog/coderabbit-how-we-built-cost-effective-generative-ai-application)) |
| Top 3 = agreed by several vendors + confirmed by verifier; severity breaks ties | Bugbot's vote + checker model |
| Reserve a slot for a lone but verified high-severity issue | Consensus can bury real bugs (inferred, not measured) |
| Show "N filtered as likely false alarms" with one click to see them | Filtering removes real bugs |
| Learn from dismissals as short written notes per repo, category and path | Semgrep: 18 to 588 false alarms filtered with one note (Vendor) ([Semgrep](https://semgrep.dev/blog/2025/announcing-ai-noise-filtering-and-triage-memories)) |

Note: the "3 items" cap is a design choice. No study was found on the best summary length.

## Suggested answers and the run helper: ask little, recommend, and keep control in code

**Plan questions.** The tools agree on a short format. GitHub Spec Kit asks at most 5 questions, one at a time, each with 2–5 options, a "Recommended" pick with a reason, and a "why it matters" line. Replying "yes" accepts the recommendation, and every answer is saved into the spec ([Spec Kit](https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/clarify.md)). Claude Code's question tool allows 1–4 questions with 2–4 options and an "Other" box ([Claude docs](https://code.claude.com/docs/en/agent-sdk/user-input)). Kiro writes requirements as testable "WHEN … THE SYSTEM SHALL …" lines ([Kiro](https://kiro.dev/docs/specs/feature-specs/requirements-first/)). Asking works: interacting with the user lifted resolve rates by up to 74% on unclear tasks, but models are bad at knowing *when* to ask ([arXiv 2502.13069](https://arxiv.org/abs/2502.13069v3)). ClarifyGPT decides by checking whether several draft solutions disagree ([arXiv 2310.10996](https://arxiv.org/abs/2310.10996v1)). The risk is over-trust: trained doctors shown wrong AI suggestions dropped from 84.9% to 73.3% accuracy ([medRxiv preprint](https://www.medrxiv.org/content/10.1101/2025.08.23.25334280)), and people who like automation over-rely the most ([arXiv 2509.08514](https://arxiv.org/abs/2509.08514?context=cs)). No tool found offers a batch "accept all", so arbitra would be going further than anyone documented.

| Plan-question rule | Source |
|---|---|
| Ask only where vendor models' plans disagree; where they agree, default and note it as an assumption | ClarifyGPT, Ambig-SWE |
| Up to 5 questions, multiple choice, recommended first, "Other" box, one-line "why it matters" | Spec Kit, Claude Code |
| "Accept all" excludes uncertain or high-impact questions; those need a separate click | Automation-bias studies |
| Save each answer as Q → A in a dated section and update the affected requirement | Spec Kit |
| Cheap code check afterwards: does the plan cover every requirement and contradict no answer? | Spec Kit `/analyze` |

**Run helper.** Long-run tools save state after every step and resume by an ID (LangGraph thread ID, Claude SDK `session_id`) ([LangGraph](https://docs.langchain.com/oss/python/langgraph/durable-execution)). Resuming re-runs the step that was interrupted, so steps must be safe to repeat. The Claude Agent SDK has turn and dollar caps (off unless set) that end a run with a named reason such as `error_max_budget_usd` ([Claude docs](https://code.claude.com/docs/fr/agent-sdk/configuration)). For waiting on a human, it recommends a "defer" that lets the process exit and resume later, instead of a blocking wait ([Claude docs](https://code.claude.com/docs/en/agent-sdk/user-input)). Anthropic's long-run harness passes state between sessions in a progress file, git commits and a JSON task list, because models tend to rewrite Markdown ([Anthropic](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)). Jules auto-approves its plan on a timer if the user walks away ([Jules docs](https://jules.google/docs/review-plan/)). The classic failure is retrying the same thing forever: "a retry only makes sense if something changes" ([JetBrains](https://www.jetbrains.com/pages/ai-agents/architecture/ai-agent-loops/)).

| Run-helper rule | Detail |
|---|---|
| State file on disk after every stage | Stage, attempts, spend, last error fingerprint, session IDs |
| Sort every stop into a type | Temporary (rate limit, network), cap hit, needs a human, real failure. Only the first two auto-resume |
| Limited retries with growing wait | About 3 tries (a commonly cited default; not tuned for arbitra) |
| Stop when nothing changes | Same error 3 times, or no new output, then escalate ([PraisonAI default 3](https://docs.praison.ai/docs/features/doom-loop-detection)) |
| Two spend caps | Per run and total across resumes; also watch dollars per minute; a missing cost report counts as a failure |
| Never wait silently | Notify, then pause in a resumable way; auto-proceed on a timer only for low-risk items |
| Frontier model only for judgment calls | Unclear errors, drafting questions. It returns a fixed choice plus a reason that code checks |
| Small handoffs | Spec and status JSON, not chat transcripts |

The evidence that "strong model plans, cheap model does the work" saves money is mostly from vendors. Morph claims a 4x spend cut ([Morph](https://www.morphllm.com/multi-agent-model-routing)), and one paper warns that splitting work across agents does not automatically make it more reliable ([atomic-forge wiki](https://github.com/kannamma-labs/atomic-forge/wiki/Planner-Executor-Split/00e6ddc5c0d7bd0ea81ff5fba5bd1ed524356ab9)).

## Ask your run, auto re-check and bug reports: tie everything to evidence and stable IDs

**Ask your run.** CodeRabbit chat starts by replying on a specific review comment and draws on a map of the code's functions. It says when it searched the web ([CodeRabbit docs](https://9e30408a.coderabbit-docs.pages.dev/guides/agent_chat)). Copilot Autofix feeds the model the rule's help text, the alert location, the code there and the alert message ([GitHub blog](https://github.blog/2024/06/fixing-security-vulnerabilities-with-ai/)). No vendor publishes how often chat answers are wrong. When chat changes behaviour ("ignore this kind of issue"), CodeRabbit can require approval first ([CodeRabbit](https://docs.coderabbit.ai/guides/learnings)).

**Auto re-check.** The standard setup is a quick scan of changed code on each commit plus a weekly or daily full scan, because change-only scans miss problems that span files. Semgrep says this outright ([Semgrep](https://semgrep.dev/docs/kb/semgrep-ci/trigger-diff-scans-env-var); [Semgrep Managed Scans](https://semgrep.dev/docs/deployment/managed-scanning/overview)). IDs that include line numbers caused every finding below an edit to show up as new ([armis-cli PR](https://github.com/ArmisSecurity/armis-cli/pull/147)). Semgrep separates "fixed" (code changed) from "removed" (rule changed) ([Semgrep](https://docs.semgrep.dev/semgrep-ci/findings-ci)). Snyk re-tests daily even without code changes, because new vulnerabilities get published ([Snyk](https://docs.snyk.io/snyk-cli/test-for-vulnerabilities/monitor-your-projects-at-regular-intervals)).

**Bug reports.** VS Code pre-fills version, OS and extensions, searches for duplicates, and lets the user submit ([VS Code](https://code.visualstudio.com/api/get-started/wrapping-up.md)). Sentry sends no personal data by default and scrubs on the device before sending ([Sentry](https://docs.sentry.io/platforms/javascript/guides/hono/data-management/sensitive-data/)). Public GitHub issues are a known leak point: one study verified 5,881 real secrets among 54,148 candidates ([arXiv 2410.23657](https://arxiv.org/html/2410.23657v3)), and Truffle Security found 721 live keys in a small sample of comments ([Truffle Security](https://trufflesecurity.com/blog/thousands-of-github-comments-leak-live-api-keys)).

| Feature | Rule for arbitra |
|---|---|
| Ask your run | Scope chat to one finding; answer from that finding's records (each vendor's verdict, verifier reasoning, code excerpt); cite `file:line@commit` |
| Ask your run | Say "not in this run's records" rather than guess; label general-knowledge answers |
| Ask your run | Chat changes to verdicts or ignores must be visible, reviewable and undoable |
| Ask your run | Report accuracy separately for confirmed vs rejected issues (Semgrep's 96% vs 41% gap) |
| Auto re-check | Issue ID = category + file + normalised code or function name, never line numbers or free-text titles (vendors word the same bug differently) |
| Auto re-check | Re-check changed files plus their direct callers; full sweep weekly; fall back to full run when the change is huge |
| Auto re-check | Auto-close only if the re-check covered that spot *and* the code changed; "no longer reported" after a model or prompt change never closes a public issue |
| Auto re-check | Store model and prompt version on every verdict, to tell "new code" from "new judge" |
| Auto bug report | Draft only; the user sees the exact text and clicks send via a pre-filled `issues/new?title=&body=` link (no token needed) |
| Auto bug report | Include version, OS, run phase, error type, provider/model names (never keys), stack trace with relative paths. Exclude code, prompts, model output, repo names, env vars |
| Auto bug report | Run a secret scan on the draft and block on hits; search for an existing issue with the same crash signature first and offer "+1" |

## Conclusion

The main lesson is that saving user effort comes from **trustworthy hand-offs, not from more autonomy**. The tools users stick with do the work unattended, but every result they hand over carries its proof and waits for one click. arbitra is better placed than most single-vendor tools here, because it already has several vendors' models and a verify step. Cross-vendor agreement can drive at least four features from one signal: which issues lead the summary, which fixes win, which plan questions are worth asking, and when a re-check counts as "fixed". No vendor has published data on this cross-model use, so it is an advantage arbitra would need to measure itself.

The second lesson is about honesty in numbers. Vendor figures of 80–96% sit next to field results of 7–43%, and nobody publishes how often auto-fixes break builds or how often chat answers are wrong. arbitra should log its own acceptance, "applied with edits", and false-close rates from day one, and should say "unverified" whenever it could not check something. The thresholds suggested here (3 retries, 5 questions, 3 summary items) are borrowed defaults, not tested values. They are starting points to tune, not settled answers.
