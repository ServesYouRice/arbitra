/**
 * One word per idea (docs/DESIGN-LANGUAGE.md, "Words"). Every main line of the run page takes its words from here:
 * the steps, the verdicts, how long something took, and what a failure means for the person. Recorded codes stay in
 * the details and the copied report.
 */

export type Mode = "audit" | "feature" | "testing";
export interface StepNode { readonly id: string; readonly kind: string; readonly label: string }

/** A step's name as a heading: "Find issues". An Audit's steps have fixed names; other graphs keep their labels. */
export function stepName(node: StepNode, mode: Mode): string {
  if (mode !== "audit") return node.label;
  if (node.kind === "deterministic") return "Read the project";
  if (node.kind === "model") return node.id === "planner" ? "Write the plan" : node.id === "critic" ? "Review the plan" : "Find issues";
  if (node.kind === "loop") return "Merge duplicates";
  if (node.kind === "subgraph") return "Check each issue";
  return node.label;
}

/** The same step as what the run is doing: "Finding issues". */
export function stepDoing(node: StepNode, mode: Mode): string {
  const name = stepName(node, mode);
  const doing: Readonly<Record<string, string>> = { "Read the project": "Reading the project", "Find issues": "Finding issues", "Merge duplicates": "Merging duplicates",
    "Check each issue": "Checking each issue", "Write the plan": "Writing the plan", "Review the plan": "Reviewing the plan" };
  return doing[name] ?? name;
}

/** Short words for a step in a list of times: "finding 53 min, checking 19, plan 26". */
export function stepShort(node: StepNode, mode: Mode): string {
  const name = stepName(node, mode);
  const short: Readonly<Record<string, string>> = { "Read the project": "reading", "Find issues": "finding", "Merge duplicates": "merging", "Check each issue": "checking", "Write the plan": "plan", "Review the plan": "review" };
  return short[name] ?? name.toLowerCase();
}

/** A length of time as people say it: "under a minute", "53 min", "1 h 06". */
export function duration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** A stage's clock in a graph box: "0:01", "1:06". */
export function clock(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** 15800000 → "15.8M"; 213000 → "213K". */
export function tokenWords(value: number): string {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value);
}

export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

/** Severity words in severity order; the record says "informational", people say "info". */
export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = typeof SEVERITIES[number];
export function severityWord(severity: string): string { return severity === "informational" ? "info" : severity; }

/** What the check decided about an issue, in its four words, in the order the Issues tab groups them. */
export const VERDICTS = ["confirmed", "unsettled", "rejected", "not checked"] as const;
export type Verdict = typeof VERDICTS[number];

/** How strong a model a task needs, in the words the plan uses: the planner's `frontier` is the strongest model. */
export const TIER_WORDS: Readonly<Record<string, string>> = Object.freeze({ frontier: "strongest", balanced: "mid", fast: "light" });
export function tierWord(tier: string): string { return TIER_WORDS[tier] ?? tier; }

/** How a check that is not a model's question read the code, as a person says it. */
const CHECK_METHODS: Readonly<Record<string, string>> = Object.freeze({
  cited_lines: "arbitra reading the cited lines", symbol_or_call_path: "arbitra following the call path", dependency_or_import_path: "arbitra following the imports",
  route_config_middleware: "arbitra reading the routes and middleware", bounded_deterministic_check: "a deterministic check", allowlisted_safe_test: "running an allowed test",
});
export function checkMethodWords(method: string | null): string | null { return method === null ? null : CHECK_METHODS[method] ?? null; }

/** What came of an issue the executing agent worked on, as recorded in results.json. */
export const RESULT_WORDS: Readonly<Record<string, string>> = Object.freeze({ fixed: "Fixed", no_change_needed: "No change needed", not_reproducible: "Not reproducible", blocked: "Blocked" });

/** What a failure means for the person: what happened, what to do, and whether resuming can help. */
export interface FailureWords { readonly what: string; readonly todo: string; readonly resumable: boolean }

/**
 * The failures a person can act on, in words. A failure arbitra cannot name keeps "resume" open (the run may have
 * stopped on something passing) and its recorded reason goes to the details. Observed (inventory, October 25, 2026):
 * a run whose snapshot was refused offered a resume that could only fail the same way.
 */
export function failureWords(reason: string | null): FailureWords {
  const text = reason ?? "";
  const files = /REPOSITORY_FILE_LIMIT_EXCEEDED:(\d+)/u.exec(text);
  if (files !== null) return { what: `The project has more than ${Number(files[1]).toLocaleString("en")} source files, more than one run reads.`, todo: "Start a new audit that reads some folders of the project, or leaves some out. Resuming this run would stop the same way.", resumable: false };
  if (/RUN_REPOSITORY_CHANGED/u.test(text)) return { what: "The project's files changed after the run read them, so the run cannot go on from where it stopped.", todo: "Put the files back as they were to resume, or start a new audit of the project as it is now.", resumable: false };
  if (/MODEL_IDENTITY_PLACEHOLDER/u.test(text)) return { what: "A model in the lineup is a placeholder, not a model this machine can run.", todo: "Start a new audit with a model chosen for each step.", resumable: false };
  if (/PROVIDER_CREDENTIAL_MISSING/u.test(text)) return { what: "A model's API key is not set on this machine.", todo: "Set the key, restart arbitra, then resume the run.", resumable: true };
  if (/ProviderUsageLimitError|usage limit|usage allowance/iu.test(text)) return { what: "A model's usage limit was reached.", todo: "Resume the run once the limit has reset. Everything it has done is kept.", resumable: true };
  if (/\bTIMEOUT\b|timed out/iu.test(text)) return { what: "A model call kept running past its time limit.", todo: "Resume the run: it goes on from where it stopped, and calls already finished are kept.", resumable: true };
  return { what: "The run stopped on an error.", todo: "Resume it to go on from where it stopped; what it finished is kept. If it stops the same way again, copy the report below and send it to whoever helps you.", resumable: true };
}

/** A failed run reads plainly first: the code and message go in the details. */
export function failureDetail(reason: string | null): string { return reason ?? "no reason recorded"; }
