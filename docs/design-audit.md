# Design audit of October 14, 2026

arbitra's design was checked stage by stage against what the model labs and the review products publish about their
own pipelines, and against the research on each stage. All pages were read on October 14, 2026, by five audits
(discovery and deduplication; peer review and verification; planning and handoff; orchestration and cost;
evaluation) and their research helpers. Product numbers are the vendors' own claims. Where a sentence says
*inference*, it is the audit's reasoning, not a source. [Research](research.md) holds the earlier sources; this page
holds the verdicts and what changes because of them.

## Why the earlier research left gaps

The research of August and October 11–12 asked how multi-agent systems should be shaped in general (debate against
voting, planners and critics, caching, effort) and checked each stage on its own. It did not study how the labs'
own bug-finding products are built end to end, though several publish exactly the pipeline arbitra runs. Three
kinds of fault followed:

- **Faults between stages.** A candidate the peer vote accepted skipped verification, so acceptance on agreement,
  which the research had rejected, came back through the vote. A verification question was built from a cluster's
  title, so a bad merge could reject a real defect. Each stage was right on its own.
- **Numbers never checked.** Unit size, one discovery pass, discovery at `xhigh`, the verifier's effort: none was
  compared with a published measurement.
- **The transports were checked for behaviour, not for cost.** Every transcript of a call that offers tools began
  with a hash of its own request, so no two such calls shared a cached prefix (below).

## What the reference pipelines do

| Step | Practice | Sources |
|---|---|---|
| Find | Several finders, each given one class of issue or one part of the code, often run more than once | Anthropic [Code Review](https://code.claude.com/docs/en/code-review): "Each agent looks for a different class of issue"; [Mythos Preview](https://www.anthropic.com/research/mythos-preview) (Apr 7, 2026) ranks files 1–5 and gives each agent a different file; Cursor [Bugbot](https://cursor.com/blog/building-bugbot) ran "eight parallel passes with randomized diff order"; Google [Naptime](https://projectzero.google/2024/06/project-naptime.html): 0.40 with one trajectory, 0.96 with ten |
| Verify | Every candidate, against the code; the top tier reproduces it by execution | Code Review: "a verification step checks candidates against actual code behavior"; [Ultrareview](https://code.claude.com/docs/en/ultrareview): "every reported finding is independently reproduced and verified"; Codex Security: "auto-validation tries to reproduce each issue in a clean container"; OpenAI [code verification](https://alignment.openai.com/scaling-code-verification) (Dec 1, 2025): "optimize for signal-to-noise first, and only then push recall" |
| Deduplicate and rank | By location and defect, then by severity | Code Review: "deduplicated, ranked by severity"; Codex review rubric: "deduplicate findings by changed location and defect/remedy"; [XBOW](https://xbow.com/blog/how-xbow-deduplicates-findings) (Sep 2, 2026): "De-duplication cannot be solved by textual similarity alone" |
| Fix | One finding at a time, in a fresh context, with a test that fails before the fix | Codex Security [fix-findings](https://learn.chatgpt.com/docs/security/plugin/fix-findings): "one at a time in separate Codex tasks", "a focused regression test that fails before the fix and passes after it"; Claude Code [best practices](https://code.claude.com/docs/en/best-practices): "write a failing test that reproduces the issue, then fix it"; Copilot Autofix: one suggestion per alert |
| Judge the result | Critics read the diff, the tests or the running program, not plan text | Google [CodeMender](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/) (Oct 6, 2025): static and dynamic analysis, fuzzing, SMT solvers and an LLM critique of the diff; Factory Missions validators check finished work; Anthropic's [harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps) (Mar 24, 2026) moved its evaluator "to a single pass at the end of the run" |

No product found votes on findings, writes one plan for dozens of findings, or critiques a multi-issue plan. No
product runs finders from different vendors side by side either: that part of arbitra has no precedent to copy, and
the evidence for it is a union effect. [CyberGym](https://arxiv.org/html/2506.02548) reports "The union of all results
yields a 27.2% success rate" against 17.9% for the best single model. Against it, errors correlate across vendors:
"models agree 60% of the time when both models err" ([arXiv 2506.07962](https://arxiv.org/abs/2506.07962)).

## Verdicts by stage

### Discovery

| Design point | Verdict | Evidence |
|---|---|---|
| Whole repository, not only a diff | Holds | Codex Security repository scans, Cursor's Vuln Hunter, Mythos |
| Models from three vendors, side by side | Holds, ahead of the products | CyberGym's union result; correlated errors are the caveat |
| One pass per unit | **Contradicted** | Naptime; Anthropic's [cyber defenders](https://www.anthropic.com/research/building-ai-cyber-defenders) (Oct 3, 2025): 5% with one attempt, "over 33% of projects" with 30; [History Is the Detector](https://arxiv.org/html/2609.05335v1): of 243 locations over ten runs, "only 56 appear in all ten runs"; [SWR-Bench](https://arxiv.org/html/2509.01494): ten runs took recall from 13.91% to 30.44%. Identical repeats saturate; varied passes help. |
| One general finder | Behind | Code Review's issue classes; Qodo, Corgea and ZeroPath per-class agents; BitsAI-CR's 219-rule taxonomy |
| Discovery at `xhigh` | Unproven | Anthropic: "Reserve `xhigh` and `max` for work where you've measured a quality gain"; [arXiv 2504.13474](https://arxiv.org/html/2504.13474): fivefold reasoning gave "only a modest 5% gain", and "extended reasoning introduces conservative biases that reduce recall by approximately 10%"; [SWE-Serve](https://arxiv.org/abs/2609.26777): high to max on Opus 5 took pass@1 from 74% to 75% "increasing mean cost by 76%" |
| Units of about 128 KB | Unproven | No source tests the size. Smaller, focused input wins in [Heelan](https://sean.heelan.io/2025/05/22/how-i-used-o3-to-find-cve-2025-37899-a-remote-zeroday-vulnerability-in-the-linux-kernels-smb-implementation/) (8 of 100 runs at about 27k tokens, 1 of 100 at about 100k), [Lost in the End](https://arxiv.org/abs/2502.06898) and Chroma's [context rot](https://www.trychroma.com/research/context-rot) |
| No ranking of where to look | Missing | Mythos ranks files; Codex Security builds a threat model first; Semgrep picks the security-relevant code first |
| No static analysis or execution | Missing | Copilot code review "blends LLM detections … with deterministic tools like ESLint and CodeQL"; [Semgrep](https://semgrep.dev/blog/2026/operationalizing-ai-powered-detection/) (May 13, 2026): "8.2x more true positives" than the model alone |
| Exact quotes as evidence | Holds against invented code, not against wrong reasoning | Quotes prove the cited text exists; false positives "stem from reasoning errors" (2504.13474) |

### Deduplication

| Design point | Verdict | Evidence |
|---|---|---|
| Fixed rules first, a model only for unclear pairs | Holds | BitsAI-CR embeddings, Cursor's classifier, XBOW's per-view similarity |
| Findings from the same answer are never joined | **Contradicted** as a rule | Codex merges by location and defect; Copilot clusters repeated patterns "into a single, cohesive unit"; XBOW guards against over-merging with thresholds per weakness class, not a ban. A measured three-vendor run accepted 53 issues among which 40 pairs overlapped. |

### Peer review

| Design point | Verdict | Evidence |
|---|---|---|
| A voting round before verification | Behind | No reference pipeline votes. "Majority Voting alone accounts for most of the performance gains" of debate ([arXiv 2508.17536](https://arxiv.org/abs/2508.17536)). In arbitra's measured runs the round decided few candidates. |
| A candidate the vote accepts skips verification | **Contradicted**: a fault | Every Anthropic tool verifies every candidate; correlated errors. In a measured three-vendor run, 26 of 53 accepted issues were never checked against the source. |
| One round, names hidden | Holds | [BenchForm](https://arxiv.org/abs/2501.13381): conformity grows with the size of the majority; [arXiv 2510.07517](https://arxiv.org/abs/2510.07517): hiding identity cut harmful answer changes by 64.3% |

### Verification

| Design point | Verdict | Evidence |
|---|---|---|
| Deterministic checks first, then one question per candidate | Holds | Anthropic's "deterministic graders where possible"; mixing problems in one prompt was worse in 81.7% of cases ([research](research.md#1-the-october-14-check)) |
| The question is the cluster's title | Behind | The verifier judges a title, not the mechanism the finders described; after a bad merge a real defect can be rejected |
| "Still needs verification" allowed, never used | Behind | Anthropic's eval guidance: give the model a way out ("Unknown"); no abstention in any measured run |
| Confidence collected, never used | Behind | Anthropic's security review drops findings under 8 of 10; confidence should rank until it is calibrated |
| Verifier one effort step below the audit | Questionable | OpenAI: more verifier budget "mostly improves calibration and reduces false alarms" |
| Verifier from the same family as a finder | Unmeasured | Same-family judges score their own family higher by 3.4–8.4 points ([arXiv 2609.17857](https://arxiv.org/abs/2609.17857)); a cross-model reviewer found more planted errors than a second same-model review ([arXiv 2610.01471](https://arxiv.org/abs/2610.01471), one author) |
| No execution rung | Behind the top tier | Ultrareview and Codex Security reproduce findings. Agents write a confirming test for only 16–37% of real bugs, so a missing test cannot count as a rejection. |

### Plan and handoff

| Design point | Verdict | Evidence |
|---|---|---|
| Validation contract before tasks; links and order checked by code | Holds, ahead | Factory writes its contract "before defining any features"; code-checked traceability was found nowhere else |
| A fresh agent per task, a progress file | Holds | Anthropic's [long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): "work on only one feature at a time" |
| One plan for every accepted issue | Behind | Every reference fixes per finding (table above) |
| Detailed tasks (about 20,000 characters, step-by-step guidance) | **Contradicted** | Anthropic's harness: a planner that specified "granular technical details upfront and got something wrong" let errors "cascade into the downstream implementation"; context files raised cost "by over 20%" without raising success ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988)) |
| No test that fails before the fix | Missing | Codex Security, Claude Code, Factory; patches that pass basic tests fail stronger ones in "over 40%" of cases ([PVBench](https://arxiv.org/abs/2603.06858)) |
| The executor does not get the verified evidence | Missing | Claude Code: "Provide the symptom, the likely location, and what 'fixed' looks like" |
| No per-issue result from the executor | Missing | Code Review marks each finding "fixed, skipped, or no change needed"; Codex records a "proof gap" |
| A critic of plan text, every blocking item revised | Behind | "self-critiquing appears to diminish plan generation performance" ([arXiv 2310.08118](https://arxiv.org/abs/2310.08118)); "significant performance gains with sound external verification" ([arXiv 2402.08115](https://arxiv.org/abs/2402.08115)); Claude Code: "A reviewer prompted to find gaps will usually report some, even when the work is sound". The one measured plan critic, Jules' (9.5% fewer failed tasks), reviews single-task plans. |
| Sections that cannot see each other | Contradicted when they share files | Claude Code agent teams; [CooperBench](https://arxiv.org/abs/2601.13295): "30% lower success rates when working together" |
| Plans judged by a model reading plan text | Behind | Products report outcomes (failed tasks, merged changes); judges prefer longer text ([AlpacaEval LC](https://arxiv.org/abs/2404.04475)) |

### Orchestration and cost

| Design point | Verdict | Evidence |
|---|---|---|
| Durable graph, one activity per call, budgets | Holds | Temporal, Restate, Inngest |
| Layered prompt, untrusted framing, instruction last | Holds | Every lab's caching and long-context guidance |
| A new temporary directory for every CLI call | Holds, measured | Claude Code [prompt caching](https://code.claude.com/docs/en/prompt-caching): "the cache is effectively scoped to one machine and directory … Two sessions in different directories therefore build different prefixes and miss each other's cache". Measured with arbitra's flags (the system prompt replaced): a call in another directory read 26,032 of 26,387 prompt tokens from the cache, so the directory costs about 355 tokens. The audit's first reading was wrong here. |
| A transcript that begins with its request's hash | **Behind**: no cache shared between calls that offer tools | The boundary marking the transcript's messages was a hash of the whole request and its first line; every verification question differed from the first token |
| Cache reads counted as full input | Behind | Vendors price a cached token at about a tenth of input, or less, and output at about five times input |
| Planner, critic and revision | Behind on cost | Plan and critic took about two thirds of a three-vendor run's tokens; Anthropic's harness cost "over 20x" its solo run and was worth it only beyond "what the current model does reliably solo" |
| Every stage at the audit's effort, Gemini at high | Contradicted until measured | All three vendors default to medium; SWE-Serve's +1 point for +76% cost |
| Subscription CLIs | Holds for the project's own runs | Claude: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage"; Google's [Antigravity FAQ](https://antigravity.google/docs/faq): wrapping `agy` in applications "is not supported under consumer plans". A product recommends API keys. |

### Evaluation

| Design point | Verdict | Evidence |
|---|---|---|
| Rules written before the benchmark is built; every planted defect and decoy proven by a test | Holds, ahead of vendor benchmarks | [Pre-registration](https://arxiv.org/abs/2311.18807); [CyberGym](https://arxiv.org/html/2506.02548) and [AIxCC](https://www.darpa.mil/news/2025/aixcc-results) use executable oracles |
| Reports outside the answer key counted as false positives, unjudged | Behind | GitHub [ReviewBench](https://github.blog/ai-and-ml/reviewbench-an-open-benchmark-for-ai-code-review/) (Oct 5, 2026): "A fixed golden set inevitably becomes incomplete"; its judge "independently determines whether those unmatched findings are true or false positives" |
| One run per panel | Behind | Semgrep: "three identical runs produced 3, 6, and then 11 distinct findings"; [MacroscopeBench](https://www.macroscope.com/benchmark) runs every model three times |
| A baseline of three single-model runs | Not cost-matched | Anthropic: token use "by itself explains 80% of the variance"; repeated samples raise coverage log-linearly ([Large Language Monkeys](https://arxiv.org/abs/2407.21787)) |
| Intervals without power analysis or clustering | Behind | Anthropic's [statistical approach to evals](https://www.anthropic.com/research/statistical-approach-to-model-evals): clustered errors "can be over three times as large", and power analysis decides whether an eval "is capable of testing a hypothesis" |

## What changes

Built in this order. The first two groups fix faults against arbitra's own rules or carry out approved changes;
the third are options compared side by side before any becomes a default. Items 1 to 10 were built on
October 14 ([provider model](provider-model.md#one-pass-per-review-stage)); item 11 needs no code
(`maxConsensusRounds: 0`).

**Faults**
1. Every clustered candidate is verified; the peer vote ranks, it neither accepts nor rejects.
2. The verification question states each source finding's mechanism (location, trigger, expected and actual
   behaviour). A rejected candidate merged from findings with different mechanisms has each finding checked alone.
3. Abstention is real: the verifier may answer that the source cannot decide, and those issues go to an
   *unverified* list, neither planned nor dropped. Confidence orders the list.
4. A transcript's markers carry a boundary shared by a stage's calls (secret to the transport), so they share the
   cached start of the prompt; a stage's input puts its source first and its question last. (A shared working
   directory was planned here and measured unnecessary.)
5. Usage is reported as uncached input, cache reads, cache writes and output, with a price-weighted total.

**Approved changes, reshaped by the audit**

6. Accepted issues that cite the same lines and the same defect merge, whichever answers they came from; the list
   is ranked by severity, then by how many models found the issue.
7. Prompts put stable content first and the per-call question last.
8. Tasks only for the issues above a severity bar; the rest are listed with their evidence.
9. The handoff carries one file per issue: the verified evidence, a test that fails before the fix, and a result
   the executor reports (fixed, not reproducible, no change needed, blocked), beside the plan's tasks. Still open: a
   length budget for tasks, few open questions asked before the handoff, and packets grouped by the files they edit
   in place of the planned join step; these wait for the plans to be scored by executing them.
10. The critic is asked only what code cannot check; each blocking item quotes the task and names the failure; its
    claims are checked by a model of a third family before they force a revision (`roles.critiqueChecker`);
    non-blocking items are capped at ten a call.

**Compared side by side before any becomes a default**

11. A pipeline without peer review: cluster, verify, deduplicate, rank. Measured October 22–23 by replaying two runs
    on their own discovery: as many confirmed issues or more, at about 40% fewer tokens; the default of the
    subscription Audit template since then ([remaining work](../WORK-REMAINING.md)).
12. Effort: discovery at `high` against `xhigh`; Gemini at `medium` against `high`; checking stages lower.
13. A second, varied discovery pass (another order, unit boundary or issue class), and smaller units.
14. A cheaper verifier first, with uncertain answers sent to the frontier model.
15. A verifier from another vendor on a sample, to measure same-family preference.
16. An execution rung for high and critical claims, in the existing Docker sandbox.
17. A local static analyser whose alerts become candidates and a risk map.

**Evaluation**: compare at matched cost, judge every report outside the key blind to its source, run each panel
more than once, write the held-out protocol with a power analysis before any held-out run, and score plans by
executing them.

## Engineering review of October 14

A second review read the code rather than the design. Codex (OpenAI's coding agent) traced 218 operations and the
handoffs between stages at 8a26cdb, reproduced each finding offline and reported 31. Each was then checked against
d05ecfa by reading the code. Thirty held. The thirty-first, distinct defects on one line merged, had already been
fixed by aa601c7. Several were rated by their worst case on the paid APIs, which the project's own runs do not use. The
review missed that each run builds its own transports in its own process, which makes two findings real today: kept
sessions and unshared limits.

Built the same day:

- A continued CLI session that is throttled or meets an upstream failure goes back to the runtime's retry, which
  waits out its backoff and the CLI's retry hint; it was resent whole at once. A refused model is no longer resent.
- A run closes its transports when it settles. CLI sessions and directories kept for a tool turn that never came
  stayed on disk, because the two-hour sweep runs only inside a later call of the same process.
- A CLI updated in place is probed again: its file's size and modification time are compared on each call.
- Clustering classifies at most 300 shared-line pairs. Since the structural rule only proposes, 50 findings on one
  line were 1,225 pairs, about 370,000 output tokens.
- A validated answer whose mapping write failed is taken from its trace instead of being paid for again.
- Traces count repairs and failed tool calls. Both were always 0 in the metrics and the trace view.
- A run pinned to the critic's earlier default protocol resumes. An incremental audit predicts the critic's default,
  so a base that ran a critic can be reused.
- The reviser is promised a critic's recheck only when one is configured.
- A quote copied from source shown in normal form C grounds in a file with decomposed accents.
- Gemini API thinking tokens count as output. `taskkill` is bounded at ten seconds. Two preset files that could not
  run are removed. Three test suites no longer fail on Windows paths or line endings.
- Docs now say that:
  - the CLI system prompt carries only arbitra's preamble;
  - most model quirks are recorded, not applied;
  - scheduling is per run;
  - cache handles are unused;
  - live verification rungs answer *inconclusive*.

  The documented-behaviour rule no longer names a README, which no stage can read.

Open:

| For | Change | Why | Size |
|---|---|---|---|
| Subscription runs | Windows process trees: report cleanup as unknown rather than done; a Job Object for descendants. Since 2d19b2f a descendant still holding the pipes two seconds after the leader exits is found by parent ID and ended | The tree is always reported terminated on Windows, so the leftover-process checks never fire | small to medium |
| Subscription runs | Admission shared across runs: a lease per account beside the CLI limit ledger, for `maxConcurrent` and retry hints | Panels side by side are separate processes with separate schedulers; only an exhausted usage window is shared | medium |
| Subscription runs | A stage prompt's stable part (protocol, schema, tools, instruction) in the CLI's system-prompt file, measured on a timed run | It travels as one user message. Claude Code caches at the end of its system prompt, which holds only the preamble, so a stage's separate calls may share more from cache. Every prompt fingerprint changes | medium, experiment |
| Subscription runs | Envelopes per stage: attempts, repairs, tool turns and replans recorded per stage, and a stage stopped when it makes no progress | Local limits multiply (64 replans, each with repairs, tool turns and retries); only the run's token budget bounds the product | medium |
| Clustering | Compare a finding with each cluster's representatives instead of every pair; refuse a transitive merge that joins two findings judged unrelated | Pairs past the 300 ceiling stay unmerged, and no later stage merges accepted issues by location; semantic merges join transitively | small to medium |
| Local I/O | An append-only artifact index, once profiling shows it matters | Each publish rewrites the whole index. The largest local run index (2,394 entries, 1.47 MB) means about 1.75 GB written over its run | medium, low priority |
| Saved graphs | Refuse non-default edge contracts when a graph is saved, until they are enforced | Edge input, output and context contracts are validated and stored, but no runner applies them | small |
| Feature, Testing | One staged-call port for every mode: source selection, admission, `stageEffort`, calls side by side | `staged-model-port.ts` sends the whole repository, and five stages hard-code `high` effort | large |
| Feature, Testing | Selected README and spec files as untrusted evidence | The snapshot holds source only, so intent documented outside comments and the request cannot be read | small to medium |
| Paid APIs | Opaque turn state per assistant message: Anthropic thinking and redacted-thinking blocks, Responses reasoning items, `reasoning_content` on compatible endpoints | The codecs keep text and tool calls only. Anthropic needs thinking kept while a tool use waits ([thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)); OpenAI advises passing reasoning items back ([reasoning items](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items)); DeepSeek refuses a follow-up without its reasoning ([thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)); Kimi and GLM keep reasoning across tool turns. The `round_trip_opaque` quirk is parsed but unused | medium |
| Paid APIs | Native output schemas, in a final turn without tools | The canonical path sends no schema, and the CLI dialects switch it off whenever tools are offered | medium |
| Paid APIs | Explicit cache control (`cache_control`, `cachedContent`) at measured reuse points | The API codecs send none, and the Messages API caches nothing without it | small |
| Tests | Native harness stand-ins that run on Windows | `stand-in.ts` writes POSIX shebang scripts, so those tests stop at spawn on Windows; the suite runs in Linux Docker meanwhile | medium |

Added to the comparisons above:

- Item 9's length budget for tasks also covers repetition. Every task carries a full contract and routing, which the
  critic and the revision read again.
- Plan sections (built October 14, behind a run setting): a pass for semantic dependencies across
  files, which the join cannot see because it only orders shared files. Examples: a migration before its use, or a
  shared contract. A blind judge preferred the sections' plan for 41 issues against 10, so measure before adding a
  call.
- Evaluation: a survival ledger that traces every source finding through clustering, verification and planning, to a
  task or a named reason, so a lost finding names the stage that lost it.

## Not found

- Any controlled comparison of one plan for many issues against fixing per issue.
- Any product that critiques a multi-issue remediation plan, or the method behind Jules' 9.5%.
- Any evaluation of deduplicating model-found defects, or of what requiring quotes costs in recall.
- Any strictly cost-matched comparison of multi-agent and single-agent code review.
- Published cache hit rates for vendor CLIs across processes.
