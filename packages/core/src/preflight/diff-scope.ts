export type DiffTargetSpec = Readonly<
  { kind: "merge_base"; base?: string; head?: string; source?: SourceTrustInput }
  | { kind: "branch_range"; base: string; head: string; source?: SourceTrustInput }
  | { kind: "commit_range"; base: string; head: string; source?: SourceTrustInput }
  | { kind: "custom_range"; range: string; source?: SourceTrustInput }
  | { kind: "staged"; source?: SourceTrustInput }
  | { kind: "working_tree"; source?: SourceTrustInput }
>;
export interface SourceTrustInput { readonly baseRemote: string | null; readonly headRemote: string | null; readonly fork: boolean }
export interface DiffGitResolver { resolveDefaultBranch(): { readonly branch: string; readonly reason: string }; mergeBase(base: string, head: string): string }
export interface DiffTarget {
  readonly kind: DiffTargetSpec["kind"]; readonly base: string; readonly head: string; readonly mergeBase: string | null; readonly range: string;
  readonly controlPlaneRevision: string; readonly content: { readonly provenance: "repo"; readonly tainted: true };
  readonly sourceTrust: { readonly trusted: false; readonly baseRemote: string | null; readonly headRemote: string | null; readonly fork: boolean; readonly crossRemote: boolean };
  readonly warnings: readonly { readonly prominence: "normal" | "prominent"; readonly code: string; readonly message: string }[];
  readonly resolutionReasons: readonly string[];
}

export function resolveDiffTarget(spec: DiffTargetSpec, git: DiffGitResolver): DiffTarget {
  const source = spec.source ?? { baseRemote: null, headRemote: null, fork: false }; const reasons: string[] = [];
  let base: string; let head: string; let mergeBase: string | null; let range: string;
  if (spec.kind === "staged") { base = "HEAD"; head = "INDEX"; mergeBase = null; range = "--cached"; reasons.push("staged_index_against_head"); }
  else if (spec.kind === "working_tree") { base = "HEAD"; head = "WORKTREE"; mergeBase = null; range = "working-tree"; reasons.push("working_tree_against_index_and_head"); }
  else {
    let requestedBase: string; let requestedHead: string;
    if (spec.kind === "custom_range") { const parsed = parseRange(spec.range); requestedBase = parsed.base; requestedHead = parsed.head; reasons.push(`custom_${parsed.operator === "..." ? "merge_base" : "direct"}_range`); }
    else if (spec.kind === "merge_base") { requestedBase = spec.base ?? ""; requestedHead = spec.head ?? ""; }
    else { requestedBase = spec.base; requestedHead = spec.head; }
    if (spec.kind === "merge_base") {
      if (requestedBase === undefined || requestedBase.trim() === "") { const resolved = git.resolveDefaultBranch(); requestedBase = resolved.branch; reasons.push(`default_branch:${resolved.reason}`); }
      if (requestedHead === undefined || requestedHead.trim() === "") requestedHead = "HEAD";
    }
    validateRevision(requestedBase); validateRevision(requestedHead); base = requestedBase; head = requestedHead;
    const useMergeBase = spec.kind === "merge_base" || spec.kind === "branch_range" || spec.kind === "custom_range" && spec.range.includes("...");
    mergeBase = useMergeBase ? git.mergeBase(base, head) : null; range = useMergeBase ? `${mergeBase}...${head}` : `${base}..${head}`; reasons.push(useMergeBase ? "merge_base_three_dot" : "direct_two_dot");
  }
  const crossRemote = source.baseRemote !== null && source.headRemote !== null && source.baseRemote !== source.headRemote; const prominent = source.fork || crossRemote;
  const warnings: DiffTarget["warnings"] = Object.freeze([Object.freeze({ prominence: prominent ? "prominent" as const : "normal" as const, code: prominent ? "UNTRUSTED_FORK_OR_CROSS_REMOTE_DIFF" : "UNTRUSTED_DIFF_CONTENT", message: prominent ? "Fork or cross-remote diff content is untrusted repository data; review suppression candidates prominently." : "Diff content is untrusted repository data regardless of authorship or remote." })]);
  return Object.freeze({ kind: spec.kind, base, head, mergeBase, range, controlPlaneRevision: base, content: Object.freeze({ provenance: "repo" as const, tainted: true as const }), sourceTrust: Object.freeze({ trusted: false as const, ...source, crossRemote }), warnings, resolutionReasons: Object.freeze(reasons) });
}
function parseRange(value: string): { base: string; head: string; operator: ".." | "..." } { const match = value.match(/^([^\s.][^\s]*?)(\.\.\.?)([^\s.][^\s]*)$/u); if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) throw new Error("INVALID_DIFF_RANGE"); return { base: match[1], operator: match[2] === "..." ? "..." : "..", head: match[3] }; }
function validateRevision(value: string): void { if (value.trim() === "" || /[\s~^:?*]/u.test(value) || value.includes("[") || value.includes("\\")) throw new Error(`INVALID_DIFF_REVISION:${value}`); }
