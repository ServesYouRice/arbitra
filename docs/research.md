# Research behind arbitra

This page collects the public research arbitra's design was checked against: guidance published by the model
labs, Western and Eastern, the review tools of comparable products, and academic papers. It records what each
source says, with quotations, and what arbitra took from it, declined, or changed because of it. Section 1 is
the latest check (October 14, 2026); the per-source sections that follow are the reference.

arbitra was conceived independently, and this research was used to pressure-test and refine it. The sources are
cited as technical literature. Naming a lab or product implies no affiliation, endorsement or compatibility, and
arbitra reproduces no third party's code, prompts or private material. Two earlier documents hold more detail and
are kept only locally (they are not in this repository): the research and decision ledger of August 18, 2026
(`docs/archive/`) and the multi-model design review (`docs/ROUND-TABLE.md`).

**Refresh policy.** Guidance, model names, prices, cache rules and CLI settings change within weeks. Read the live
pages again before a change to the pipeline's shape, and before a release. Volatile facts belong in model
profiles and transports, not in workflow semantics. A design change that alters what the pipeline does is checked
against Anthropic's current guidance before it is built (the owner's condition since October 12, 2026).

Contents: [1. October 14 check](#1-the-october-14-check) ·
[2. Timeline](#2-how-the-research-shaped-arbitra) · [3. Anthropic](#3-anthropic) · [4. OpenAI](#4-openai) ·
[5. Google](#5-google) · [6. Meta, Mistral, xAI](#6-meta-mistral-and-xai) · [7. Eastern labs](#7-eastern-labs) ·
[8. Comparable products](#8-comparable-products) · [9. Papers](#9-papers) ·
[10. Conclusions](#10-conclusions-across-the-sources) · [11. Sources](#11-source-index)

## 1. The October 14 check

After the P20 pilot runs, seven changes were proposed and six were approved by the owner on condition that they
agree with Anthropic's guidance (the seventh, starting later stages while the audit still runs, was not
approved). The six were checked against Anthropic's pages, then against ten other labs and the papers below,
all read on October 14, 2026.

| Proposal | Verdict | What the sources say | How it is to be built |
|---|---|---|---|
| A plan only for the top-ranked issues, the rest on request | Partly supported | Anthropic: "only increasing complexity when needed"; its managed Code Review delivers findings and applies fixes only with `--fix`. No lab discusses remediation plans as such. | Plan the issues above a severity bar after ranking; list the rest without tasks. Measure what the plan adds. |
| Merge accepted issues that cite the same lines, and rank the list | Supported | Anthropic Code Review: candidates are verified, then "deduplicated, ranked by severity". Codex's review rubric: "deduplicate findings by changed location and defect/remedy". | Merge on the same lines **and** the same defect (two defects on one line stay apart); rank by severity, then by how many models found it. |
| Rethink the plan critic | Supported, the cap only in part | Claude Code: "A reviewer prompted to find gaps will usually report some, even when the work is sound … flag only gaps that affect correctness". CriticGPT: longer critiques carry more "hallucinations and nitpicks". Anthropic's Code Review caps only nits. | Each blocking item names the failure it would cause; the critic is asked only what code cannot check; non-blocking items are capped, blocking ones are not; a critic's claim is checked before it forces a revision. |
| Accept a finding without a verification question when several vendors' models found it | **Not supported as proposed** | Every Anthropic review tool verifies every finding, redundant finders included. Papers: "models agree 60% of the time when both models err", and errors correlate "even with distinct architectures and providers". | Not built. Agreement raises an issue's rank instead; the question stays (it may run at a lower effort). |
| A join step for plan sections that edit the same file, or sections by the files tasks edit | Supported | Claude Code agent teams: "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files." LLMCompiler and Skeleton-of-Thought: split along dependencies; independent parts in parallel. | Form sections by the files their tasks will edit where possible; join the rest with one check over the tasks that share a file. |
| Stable repository text first, the per-call question last | Supported by every lab with caching guidance | Anthropic: "Place static content … at the beginning of your prompt"; "Queries at the end can improve response quality by up to 30 percent". OpenAI, Google, Meta, Mistral, xAI, DeepSeek and Qwen say the same for caching. | Reorder prompts: repository context, then stable instructions, then the item. Keep effort, tools and schema identical across a stage, and warm the cache before parallel calls (Anthropic: an entry "only becomes available after the first response begins"). |

**A change taken back the same evening.** Grouping verification questions by the files they cite (three to a call)
was built and set for protocol 2.7.0 that afternoon. The research found that accuracy falls when different
reasoning problems share a prompt (BatchPrompt; Wang, Kodner and Rambow 2025: worse in 81.7% of mixed cases, by 13.5
points on average), Google advises "one prompt per instruction", and Anthropic's own reviewers check one finding
per sub-task. The setting stays in arbitra, off by default, and 2.7.0 asks one question a call.

**A fault the research confirmed.** Codex never read `base_instructions` from the command line: it is not a
`config.toml` key, only an internal override, and unknown keys are ignored without `--strict-config`. arbitra's
instructions now travel in `model_instructions_file`, which replaces Codex's built-in instructions (Codex's schema
"STRONGLY DISCOURAGES" this for coding agents; arbitra uses Codex as a plain completion engine with its tools off).

## 2. How the research shaped arbitra

| Date | Research | What changed in arbitra |
|---|---|---|
| August 18, 2026 | Per-lab ledger: Anthropic, Google, OpenAI, DeepSeek, Moonshot, Qwen, Z.AI, and the products Factory, Cognition, Qodo, Cursor | The pipeline's shape: a complexity gate before fan-out, parallel independent discovery, structured peer review instead of free debate, one planner and one critic, a validation contract, state outside the models, a cache-aware prompt compiler, transport separate from model profile ([conclusions](#10-conclusions-across-the-sources)) |
| Design review | Multi-model review of the specification with the sources in section 11 | Repository content treated as untrusted; independence measured rather than assumed; replay mode; a known-defect corpus with decoys; the honest null result |
| October 11 | Comparable reviewers: Karpathy's llm-council, Claude Code's code-review plugin, PR-Agent, claude-code-security-review | Calls side by side; no repair call for a whole reply (keep the valid operations); a finding checked against the code it cites |
| October 12 | Anthropic's guidance on review, critics and effort | One pass per review stage; every undecided candidate verified; checking stages one effort step below the audit ([provider model](provider-model.md#one-pass-per-review-stage)) |
| October 14 | Eleven labs and the papers below | Section 1 |

## 3. Anthropic

Pages read on October 14, 2026, unless noted. The Claude docs pages carry no dates; the prompting page covers models
up to Opus 5.5 and Fable 5.1.

**Building and orchestrating agents**
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (December 19, 2024):
  "we recommend finding the simplest solution possible, and only increasing complexity when needed"; "consider
  adding complexity only when it demonstrably improves outcomes". Parallelization by sectioning ("independent
  subtasks run in parallel") and by voting: "Reviewing a piece of code for vulnerabilities, where several different
  prompts review and flag the code", with "different vote thresholds to balance false positives and negatives".
  Evaluator-optimizer is "particularly effective when we have clear evaluation criteria". → The typed graph, the
  complexity gate, parallel discovery; vote thresholds as a ranking signal.
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  (June 13, 2025): multi-agent systems "use about 15× more tokens than chats"; worth it when "the value of the task
  is high enough"; domains with "many dependencies between agents are not a good fit"; "Without detailed task
  descriptions, agents duplicate work, leave gaps". → Measure cost against value; give each section a precise scope.
- [When (and when not) to use multi-agent systems](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them):
  3 to 10 times the tokens of a single agent; worth it for context isolation, genuine parallelism and specialization
  (August ledger). → Fan out only where work is parallel.
- [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  (March 24, 2026): "every component in a harness encodes an assumption about what the model can't do on its own";
  the evaluator "is still an LLM that is inclined to be generous towards LLM-generated outputs" and was seen to
  "identify legitimate issues, then talk itself into deciding they weren't a big deal". → Re-test each stage as models
  improve; a critic of the same family is lenient.
- [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  (September 29, 2025): "the smallest possible set of high-signal tokens"; sub-agents return "a condensed, distilled
  summary of its work (often 1,000-2,000 tokens)". → Calls read only what they need (cited files, own tasks).
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (September 11,
  2025): tool response structure affects performance; Claude Code caps tool responses at 25,000 tokens. → Bounded
  source tool results (32 KB, whole lines).
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  (January 9, 2026): "choosing deterministic graders where possible, LLM graders where necessary"; "give the LLM a way
  out, like providing an instruction to return 'Unknown'"; "grade each dimension with an isolated LLM-as-judge". →
  Deterministic checks before model checks; `STILL_NEEDS_VERIFICATION`; one question per finding.

**Prompting**
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices):
  "Place your long documents and inputs near the top of your prompt, above your query, instructions, and examples";
  "Queries at the end can improve response quality by up to 30 percent"; wrap long documents in `<document>` tags
  with their source; "newer models can reliably match complex schemas when told to, especially if implemented with
  retries"; a prompt that asks for reasoning "in `<thinking>` tags, may be declined"; "Use subagents when tasks can
  run in parallel … and don't need to share state". → Repository first, question last; schema with repairs; no
  reasoning-tag requests.
- Model pages ([Opus 4.8 code-review harnesses](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8#code-review-harnesses),
  Opus 5, Opus 5.5, Fable 5): finders should "Report every issue you find … Do not filter for importance or
  confidence at this stage - a separate verification step will do that"; "include your confidence level and an
  estimated severity so a downstream filter can rank them"; "be concrete about where the bar is"; bar-limiting
  instructions can make the model "identify the bugs, and then not report findings it judges to be below your stated
  bar"; "Separate, fresh-context verifier subagents tend to outperform self-critique"; instructions to re-check its
  own work "cause over-verification". → Discovery reports everything with severity and confidence; filtering is
  verification's job; the critic is a separate model.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) and the Opus 5.5 page: "Start at `medium` …
  test several levels against your own evals"; "Reserve `xhigh` and `max` for work where you've measured a quality
  gain"; "Lowering effort reduces thinking … more reliably than prompt instructions do"; "Changing the top-level
  effort value between requests invalidates prompt caching". → `stageEffort`; one effort per stage.
- [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations):
  "Allow Claude to say 'I don't know'"; "If it can't find a quote, it must retract the claim"; best-of-N: "Inconsistencies
  across outputs could indicate hallucinations". → Evidence must be exact quotations; agreement is a confidence signal.
- [Develop tests](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests): "Generally best practice to use
  a different model to evaluate than the model used to generate the evaluated output"; "Use a grader model with
  thinking on". → The critic is another vendor's model.

**Caching**
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): "Place static content (tool
  definitions, system instructions, context, examples) at the beginning of your prompt"; "Cache hits require 100%
  identical prompt segments"; "a cache entry only becomes available after the first response begins. If you need cache
  hits for parallel requests, wait for the first response"; minimum 512 tokens for Opus 5.5, Sonnet 5.5 and Haiku 5.5;
  five-minute default lifetime; reads cost 0.1 of input (0.05 on Opus 5.5 and Sonnet 5.5). Measured in arbitra
  (October 14): a continued Claude Code session read 91% of a turn's prompt from the cache, a turn sent whole 19%.

**Anthropic's own review tools**
- [Code Review](https://code.claude.com/docs/en/code-review): "a verification step checks candidates against actual code
  behavior to filter out false positives. The results are deduplicated, ranked by severity"; "Findings are tagged by
  severity and don't approve or block your PR"; `--fix` applies them; `REVIEW.md` can set a "Verification bar" and cap
  "Nit volume". [Ultrareview](https://code.claude.com/docs/en/ultrareview): "every reported finding is independently
  reproduced and verified".
- [code-review plugin](https://github.com/anthropics/claude-code/tree/main/plugins/code-review) (command updated March
  12, 2026): parallel finders, then "launch parallel subagents to validate the issue"; "Only post ONE comment per unique
  issue". Its README still describes an older 0 to 100 score with a threshold of 80.
- [claude-code-security-review](https://github.com/anthropics/claude-code-security-review) (prompt of August 6, 2025):
  "for each vulnerability … create a new sub-task to filter out false-positives. Launch these sub-tasks as parallel
  sub-tasks", then drop those with confidence below 8; deterministic exclusion rules run first.
- [Agent teams](https://code.claude.com/docs/en/agent-teams): "Two teammates editing the same file leads to overwrites.
  Break the work so each teammate owns a different set of files." [Best practices](https://code.claude.com/docs/en/best-practices):
  "A reviewer prompted to find gaps will usually report some, even when the work is sound … Tell the reviewer to flag
  only gaps that affect correctness or the stated requirements, and treat the rest as optional."

## 4. OpenAI

- **Codex CLI configuration** ([openai/codex](https://github.com/openai/codex), release 0.162.1 of October 9, 2026):
  `base_instructions` is not a `config.toml` key; the order is a programmatic override, then `model_instructions_file`,
  then `instructions`. `model_instructions_file` "will override the built-in instructions for the selected model. Users
  are STRONGLY DISCOURAGED from using this field"; `developer_instructions` is "inserted as a `developer` role message";
  `experimental_instructions_file` was renamed to `model_instructions_file` in 0.88.0 (January 21, 2026). Unknown keys
  are ignored unless `--strict-config`. → arbitra 1e000da; a Codex notice of an ignored setting fails the call.
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): "Put stable developer instructions and
  shared reference material first"; "Cache reuse requires the entire rendered prefix to match"; the prefix changes
  with model, tools, schema, `reasoning.effort` and verbosity; minimum 1,024 tokens from GPT-5.6. Measured in arbitra:
  a continued Codex session read 98% of a turn's prompt from the cache.
- Reasoning ([reasoning](https://developers.openai.com/api/docs/guides/reasoning),
  [best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices), the GPT-6 page): "Avoid
  chain-of-thought prompts"; "Treat `reasoning.effort` as a tuning knob, not the primary way to recover quality";
  `xhigh` "Only use when your evals show a clear benefit … security and code review"; reserve "at least 25,000 tokens
  for reasoning and outputs"; GPT-6 Astra is sensitive to `AGENTS.md`; keep effort unchanged to keep the cache.
  [GPT-5.1](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide) and
  [GPT-5.2](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide) prompting guides (design
  review). → No step-by-step wording; Codex runs in an empty directory with project docs off.
- Structured outputs ([guide](https://developers.openai.com/api/docs/guides/structured-outputs)): "always using
  Structured Outputs instead of JSON mode"; "always enabling strict mode"; examples "may hurt performance for reasoning
  models". → `--output-schema` when no tools are offered.
- Agents ([A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)):
  "maximize a single agent's capabilities first"; several agents when "Comparing independent findings improves
  coverage". Symphony, ExecPlans and harness engineering (August ledger): one authoritative control plane;
  self-contained, restartable plans; trace before tuning.
- Evaluation ([best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)): "Position bias
  (response order), verbosity bias (preferring longer responses)"; "Use pairwise comparison or pass/fail"; "Control for
  response lengths"; "Validate agreement against your human labels". Lists "Multiple questions or intents in a single
  request" among sources of errors.
- Code review ([A practical approach to verifying code at scale](https://alignment.openai.com/scaling-code-verification),
  December 1, 2025): "We optimize for signal-to-noise first, and only then push recall"; "Giving the reviewer repo-wide
  tools and execution access improves both recall and precision"; extra verifier budget "mostly improves calibration and
  reduces false alarms". Codex's review rubric: "If there is no finding that a person would definitely love to see and
  fix, prefer outputting no findings"; findings tagged P0 to P3 with a confidence score; "deduplicate findings by changed
  location and defect/remedy". → Verification with source tools; merge by location and defect.

## 5. Google

- [Prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies): "Supply all the context first.
  Place your specific instructions or questions at the very *end*"; behavioural constraints and output format in the
  system instruction; "Instead of having many instructions in one prompt, create one prompt per instruction".
  [Long context](https://ai.google.dev/gemini-api/docs/long-context): the query at the end.
- Caching ([caching](https://ai.google.dev/gemini-api/docs/caching)): implicit caching from 4,096 tokens on Gemini 4
  Argon and 3.8 Flash; "putting large and common contents at the beginning"; "send requests with similar prefix in a
  short amount of time"; implicit hits on Argon at a 95% discount, no explicit caching on Argon. Measured in arbitra
  (Antigravity CLI): a continued conversation read 21,246 tokens from the cache once and none another time.
- Thinking ([thinking](https://ai.google.dev/gemini-api/docs/thinking), [Gemini 3](https://ai.google.dev/gemini-api/docs/gemini-3)):
  run evals at each level and "pick the lowest level that meets your quality bar"; not necessary "to have the model
  outline, plan, or detail reasoning steps"; lower the thinking level "instead of setting a small `max_output_tokens`".
  Measured in arbitra: 93% to 98% of Gemini 3.8 Flash's output at high is thinking.
- Structured output: "Always validate values in your application"; keep the active tool set to "10-20 tools maximum".
- Orchestration ([multi-agent patterns in ADK](https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/),
  December 16, 2025; [ADK patterns](https://adk.dev/workflows/patterns/)): parallel agents write "to a unique key"; a
  critic checks "against specific, hard-coded criteria or logical checks"; loops need `max_iterations`; "Start with a
  sequential chain, debug it, and then add complexity". [Towards a science of scaling agent systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
  (180 configurations, August ledger): parallelizable tasks gain from several agents, sequential planning loses. → Parallel
  discovery, one planner.
- Judges (Vertex AI "Configure a judge model", updated October 13, 2026): "you can enable response flipping";
  "Additional sampling can help negate the inherent randomness", default 4 samples.
- Code review: Gemini Code Assist's `comment_severity_threshold` defaults to MEDIUM. Google Research (May 23, 2023)
  tuned suggested edits until "50% … are correct", because wrong ones "reduce the developers' trust": "we traded quantity
  for quality".
- Antigravity CLI ([FAQ](https://antigravity.google/docs/faq), October 11): headless `agy -p` "is intended for direct
  scripting and CI workflows"; wrapping `agy` in other applications "is not supported under consumer plans" (the owner was
  told; see `WORK-REMAINING.md`).

## 6. Meta, Mistral and xAI

- **Meta** (Model API docs): caching "Put stable content first … and put variable content last", with a cache key per
  use case; reasoning: "Use the lowest level that gives you acceptable results"; structured output decoding is
  constrained. The Llama prompting guide describes self-consistency, "selecting the most frequent answer from multiple
  generations, at the cost of higher compute". No guidance on judges or code review found.
- **Mistral** ([prompt caching](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching)): a cache key
  "increases the chance of a cache hit, but it doesn't guarantee one"; caching is "less useful for … requests that change
  the first part of the prompt on every call"; `reasoning_effort="high"` recommended for agentic and code use on Medium
  3.5; "It is common to employ another LLM for evaluation"; "A single generation per input may not give you a reliable
  picture". Long system prompts drift into "slight contradictions".
- **xAI** (docs.x.ai): "Never modify earlier messages — Only append new ones"; "Front-load static content"; omitting
  reasoning content "is the top cause of cache misses"; reasoning cannot be disabled, so set effort on every request.
  On judges: "Position bias, preference for longer answers, drift from human judgment"; give "a specific rubric with
  examples of each score, ask it to reason before it scores, and randomize the order of answers"; "Run each item several
  times, report the mean and spread"; prompts tuned for one model need comparable tuning for another.

## 7. Eastern labs

- **DeepSeek.** R1 ([repository](https://github.com/deepseek-ai/DeepSeek-R1); [paper v2](https://arxiv.org/abs/2501.12948),
  January 4, 2026): "Avoid adding a system prompt; all instructions should be contained within the user prompt";
  "Few-shot prompting consistently degrades its performance … directly describe the problem and specify the output
  format using a zero-shot setting". [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode): no
  temperature in thinking mode; reasoning content "must be fully passed back" with tools. [Context caching](https://api-docs.deepseek.com/guides/kv_cache):
  on by default, a hit only when a prefix "fully matches", best effort. DeepSeekMath-V2 ([arXiv 2511.22570](https://arxiv.org/abs/2511.22570)):
  a verifier can be rewarded while "hallucinating non-existent issues"; meta-verification "assesses whether issues
  identified by the verifier indeed exist" and is "easier than identifying issues from scratch"; an analysis is kept
  when "the majority of meta-assessments confirm its findings … Otherwise … routed to human experts". → The closest lab
  precedent for arbitra: check each claimed issue separately, send the unsettled ones on. Also: zero-shot prompts with
  an explicit output format.
- **Alibaba Qwen.** Qwen3.6 card ([Hugging Face](https://huggingface.co/Qwen/Qwen3.6-35B-A3B), April 2026): thinking
  mode for coding at `temperature=0.6, top_p=0.95, top_k=20`; no `/think` switch in 3.6; trained to use earlier
  thinking (`preserve_thinking`); the Qwen3 card says "DO NOT use greedy decoding". [Model Studio context cache](https://www.alibabacloud.com/help/en/model-studio/user-guide/context-cache)
  (October 11, 2026): "place duplicate content at the beginning of a prompt and unique content at the end"; implicit
  hits billed at about 20%. ProcessBench ([arXiv 2412.06559](https://arxiv.org/abs/2412.06559)): prompted general
  models make better critics than process reward models. PRM lessons ([arXiv 2501.07301](https://arxiv.org/abs/2501.07301)):
  keeping only items where two independent signals agree kept "approximately 40% of the data" at comparable quality —
  agreement filters with high precision at a large cost in recall. Qwen Code's Agent Arena (August ledger) runs whole
  agents in isolated worktrees and compares them afterwards.
- **Moonshot (Kimi).** [Thinking models](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model): do not set
  temperature on K2.6 and K2.7-code, `max_tokens` of at least 16,000, keep reasoning content within a task. The K2.5
  report ([arXiv 2602.02276](https://arxiv.org/abs/2602.02276)): an orchestrator splits tasks into "heterogeneous
  sub-problems", warns of "serial collapse" back into one agent, and measures by "Critical Steps … inspired by the
  critical path" (up to 4.5 times faster). Kimi's prompt guide (August ledger) summarizes old history instead of
  accumulating it. → Measure a split plan by its critical path.
- **Zhipu (Z.AI GLM).** [Thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode): "return the complete,
  unmodified reasoning_content"; GLM-5.3 thinking cannot be disabled; turn thinking on for "complex planning or code
  debugging". Its coding endpoints speak OpenAI and Anthropic protocols (August ledger). → Protocol compatibility is not
  behavioural compatibility.
- **MiniMax.** [Why interleaved thinking matters](https://www.minimax.io/news/why-is-interleaved-thinking-important-for-m2)
  (November 3, 2025): when earlier thinking is dropped, "planning degrades" (a tool benchmark 87 against 64); the M2 card:
  "Do not remove the `<think>...</think>` part". → Keep a model's thinking within a conversation where its transport
  allows it (the CLI sessions now do).
- **ByteDance.** Seed-OSS: thinking budgets in multiples of 512, and on simple tasks the score fluctuates as the budget
  grows. BitsAI-CR ([arXiv 2501.15134](https://arxiv.org/abs/2501.15134), deployed): "RuleChecker for initial issue
  detection and ReviewFilter for precision verification", 75.0% precision. → arbitra's detect-then-verify shape.
- **Tencent.** An industrial study ([arXiv 2601.18844](https://arxiv.org/abs/2601.18844)): combining an LLM with static
  analysis eliminates "94-98% of false positives with high recall".

## 8. Comparable products

- **Factory** ([Missions](https://factory.ai/news/missions-architecture)): fresh workers with narrow goals and shared
  external state; validation planned as an artifact. → The validation contract.
- **Cognition** ([Don't build multi-agents](https://cognition.ai/blog/dont-build-multi-agents)): parallel writers make
  incompatible implicit decisions; review separates more safely than coupled implementation. → One planner; the join
  check for plan sections.
- **Qodo** ([single- vs multi-agent code review](https://www.qodo.ai/blog/single-agent-vs-multi-agent-code-review/);
  [PR-Agent](https://github.com/qodo-ai/pr-agent)): repository context beyond the diff, high-signal structured findings;
  PR-Agent keeps the valid items of a reply and drops the rest. → Partial acceptance of a reply (7986f77).
- **Cursor** ([Bugbot](https://cursor.com/docs/bugbot), [security agents](https://cursor.com/blog/security-agents)): a
  light classifier for semantically duplicate findings across agents. → Deterministic clustering first, a model only for
  ambiguous pairs.
- **llm-council** ([Karpathy](https://github.com/karpathy/llm-council)): all models answer at once, review each other at
  once, then a chair decides: three waits, not rounds of calls. → Reviewers of a round side by side.

## 9. Papers

**Judges and their biases**
- Zheng et al., MT-Bench ([arXiv 2306.05685](https://arxiv.org/abs/2306.05685)): verbosity bias ("favors longer,
  verbose responses"); position bias, countered by "only declare a win when an answer is preferred in both orders";
  self-enhancement (GPT-4 +10%, Claude-v1 +25% for itself); reference-guided grading cut GPT-4's math failures from 14 to
  3 of 20.
- Length-controlled AlpacaEval ([arXiv 2404.04475](https://arxiv.org/abs/2404.04475)): controlling for length raised
  agreement with human rankings from 0.94 to 0.98.
- CALM ([arXiv 2410.02736](https://arxiv.org/abs/2410.02736)): position bias grows with the number of answers; some
  models favour verbose answers, others avoid them; "Avoid using the same model to generate and judge answers".
- Self-preference in rubric-based evaluation ([arXiv 2604.06996](https://arxiv.org/pdf/2604.06996), design review).
- → arbitra's planner comparison (October 14) drew one order per issue and used another vendor's model as judge; it did
  not show both orders or control for length, and the plan it preferred was 2.4 times as long. Repeat it with both
  orders and length-matched excerpts before a default changes.

**Critics and self-correction**
- CriticGPT, "LLM Critics Help Catch LLM Bugs" ([arXiv 2407.00215](https://arxiv.org/abs/2407.00215)): longer critiques
  "are, however, also more likely to include hallucinations and nitpicks"; the chance of catching a bug grows with the
  number of claims; models nitpick and hallucinate far more than humans; critiques were chosen by a score with a length
  penalty, about four highlights each.
- Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet" ([arXiv 2310.01798](https://arxiv.org/abs/2310.01798)):
  a model is "more likely to modify a correct answer to an incorrect one"; without oracle labels self-correction
  "consistently results in a decrease in performance".
- "Are LLMs Reliable Code Reviewers?" ([arXiv 2603.00539](https://arxiv.org/abs/2603.00539)): more detailed review prompts,
  "particularly with those requiring explanations and proposed corrections, leads to higher misjudgment rates"; one
  model rejected correct code 26.2% of the time with a direct prompt and 73.2% with the full prompt.
- SWR-Bench ([arXiv 2509.01494](https://arxiv.org/abs/2509.01494)): aggregating reviews raises recall, "enhancing
  Precision by reducing false positives remains a key priority", and "most false positives arise from insufficient
  contextual understanding".
- → The critic's items are claims to check, not orders; a blocking item names its failure; review prompts stay plain.

**Agreement, voting and debate**
- Self-consistency (Wang et al., [arXiv 2203.11171](https://arxiv.org/abs/2203.11171)): consistency "is highly
  correlated with accuracy"; low consistency signals low confidence.
- Correlated errors ([arXiv 2506.07962](https://arxiv.org/abs/2506.07962), ICML 2025): "models agree 60% of the time when
  both models err"; "larger and more accurate models have highly correlated errors, even with distinct architectures and
  providers". "Great Models Think Alike" ([arXiv 2502.04313](https://arxiv.org/abs/2502.04313)): mistakes grow more
  similar with capability. Self-MoA ([arXiv 2502.00674](https://arxiv.org/abs/2502.00674)): mixing different models often
  lowers average quality.
- "Verify when Uncertain" ([arXiv 2502.15845](https://arxiv.org/abs/2502.15845)): call the verifier only for a subset,
  chosen by cross-model consistency — a cost trade-off, not a quality gain.
- Debate: Du et al. ([arXiv 2305.14325](https://arxiv.org/abs/2305.14325)); against it, Huang et al. (debate with nine
  answers 83.0 against 88.2 for self-consistency) and "Debate or Vote" ([arXiv 2508.17536](https://arxiv.org/abs/2508.17536),
  NeurIPS 2025): "Majority Voting alone accounts for most of the performance gains"; sycophancy and failure modes in
  debate ([2509.23055](https://arxiv.org/pdf/2509.23055), [2509.05396](https://arxiv.org/pdf/2509.05396)); Minority
  Sentinel on overturning majorities ([2606.29270](https://arxiv.org/pdf/2606.29270)). MAST, why multi-agent systems fail
  ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)).
- → Agreement ranks; it does not replace verification. One review round, no free debate.

**Several items in one prompt**
- Batch Prompting ([arXiv 2301.08721](https://arxiv.org/abs/2301.08721)): batch size and task complexity affect accuracy.
  BatchPrompt ([arXiv 2309.00384](https://arxiv.org/abs/2309.00384)): batching "will inevitably lead to worse performance,
  compared to single-data prompting", and depends on position and order.
- Wang, Kodner and Rambow, multiple problems in one prompt ([GEM 2025](https://aclanthology.org/2025.gem-1.14)): same-source
  classification lost 3.2 points (72.3% against 75.5%); mixing reasoning problems from different sources made 81.7% of
  cases worse, by 13.5 points on average, even with five or fewer.
- → One verification question a call (section 1).

**Splitting and joining plans**
- LLMCompiler ([arXiv 2312.04511](https://arxiv.org/abs/2312.04511), ICML 2024): a planner builds "a directed acyclic graph
  of task dependencies" and replans from intermediate results; up to 3.7 times faster and 6.7 times cheaper; parallel
  outlines without dependencies are limited "in complex scenarios such as coding". Skeleton-of-Thought ([arXiv 2307.15337](https://arxiv.org/abs/2307.15337)):
  works "when the question can be answered in several points whose details can be expanded independently", with a router
  deciding when.
- → Sections formed along what tasks share, joined by a check, and measured by their critical path.

**Bug finding**
- SecLLMHolmes ([arXiv 2312.12575](https://arxiv.org/abs/2312.12575)): non-deterministic answers; renaming identifiers or
  adding library functions changed the answer in 26% and 17% of cases. No paper evaluates deduplication of model-found
  vulnerabilities. → The same defect returns in other words across runs; clustering stays deterministic first.
- Security of the pipeline itself: GitInject ([arXiv 2606.09935](https://arxiv.org/html/2606.09935v1)) on prompt injection
  in AI CI pipelines; Willison's [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). →
  Repository content is untrusted data, framed and never followed ([security](security.md)).

## 10. Conclusions across the sources

These held in August and still hold, with the October additions marked.

1. **More agents are not automatically better.** A complexity gate before fan-out; parallel work only where it is
   genuinely parallel (Anthropic, Google, Cognition, Qwen).
2. **Parallel discovery, one planner.** Discovery fans out; planning is sequential and dependency-heavy (Google's 180
   configurations; Cognition). *October:* a plan may be written in sections only along what the sections do not share,
   with a join check (Anthropic agent teams, LLMCompiler).
3. **State lives outside the models.** The application owns run state, retries, provenance, consensus, tasks, budgets and
   artifacts (OpenAI Symphony, Anthropic harnesses, ADK, Factory).
4. **Verification is designed, not improvised.** *October:* every finding a review leaves undecided gets its own
   question; agreement between models ranks but does not verify; a critic's claims are checked like findings
   (DeepSeekMath-V2, CriticGPT, every lab's own review tool).
5. **Context stays scarce.** Each call reads what it needs: cited files, its own tasks (all labs' context guidance).
6. **Stable prefixes pay twice.** For cost (every lab's caching) and, with the question last, for quality (Anthropic,
   Google).
7. **Wire compatibility is not behavioural compatibility.** *October:* nor is a CLI's acceptance of a setting proof that
   it uses it (Codex's `base_instructions`).
8. **Evaluate the harness.** Traces and evals of arbitra's own runs decide routing, rounds and models; a judge is checked
   for position and length bias.
9. *October:* **Precision before volume.** Findings and critiques a person must act on are filtered for signal first
   (OpenAI, Google Research, Anthropic's nit caps); finders still report everything, and filtering is a separate step.

## 11. Source index

Every page above was read on October 14, 2026 unless a date in the text says otherwise. The August ledger's further
sources include Anthropic's [multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns),
[effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
[managed agents](https://www.anthropic.com/engineering/managed-agents) and the [advisor strategy](https://claude.com/blog/the-advisor-strategy);
Google's [ADK documentation](https://google.github.io/adk-docs/) and Cloud [design patterns for agentic systems](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system);
OpenAI's [Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/), [ExecPlans](https://developers.openai.com/cookbook/articles/codex_exec_plans),
[harness engineering](https://openai.com/index/harness-engineering/) and [agent evals](https://developers.openai.com/api/docs/guides/agent-evals);
DeepSeek's [API documentation](https://api-docs.deepseek.com/); Moonshot's [Kimi K2](https://github.com/MoonshotAI/Kimi-K2)
and [technical report](https://arxiv.org/abs/2507.20534); [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/arena/);
Z.AI's [GLM-5 overview](https://docs.z.ai/guides/llm/glm-5); and the product documentation of Factory, Cognition, Qodo and
Cursor cited in section 8.
