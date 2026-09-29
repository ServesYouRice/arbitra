import type { DocumentedBehaviourConflict, RequirementBehaviourConflict } from "@arbitra/schemas/documented-behaviour.js";
import { anchorLineEvidence, widenToQuote, type LineEvidence } from "./evidence-grounding.js";
import type { RepositorySnapshot } from "./repository.js";

type SnapshotFile = RepositorySnapshot["files"][number];

/**
 * Grounds both quotations of each conflict: the code in the snapshot, and the documentation in
 * the snapshot or, with a null path, in the request. Called inside a model call's parse, so a
 * misquoted conflict is repaired rather than dropped; a stored reply grounds again unchanged.
 */
export function groundBehaviourConflicts<T extends DocumentedBehaviourConflict>(conflicts: readonly T[], snapshot: RepositorySnapshot, request?: string): T[] {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  return conflicts.map((conflict, index) => {
    const at = `documentedBehaviourConflicts[${index}]`;
    const code = groundQuote(conflict.code, files.get(conflict.code.path));
    if (code === null) throw new Error(`DOCUMENTED_BEHAVIOUR_CONFLICT_UNGROUNDED: ${at}.code.text must be an exact excerpt of ${conflict.code.path} lines ${conflict.code.startLine}-${conflict.code.endLine}`);
    const { path, startLine, endLine, text } = conflict.documentation;
    if (path === null || startLine === null || endLine === null) {
      if (request === undefined) throw new Error(`DOCUMENTED_BEHAVIOUR_CONFLICT_UNGROUNDED: ${at}.documentation must quote a repository file with its path and lines`);
      if (!request.includes(text)) throw new Error(`DOCUMENTED_BEHAVIOUR_CONFLICT_UNGROUNDED: ${at}.documentation has a null path, so its text must be an exact excerpt of the request`);
      return { ...conflict, code } as T;
    }
    const documentation = groundQuote({ path, startLine, endLine, text }, files.get(path));
    if (documentation === null) throw new Error(`DOCUMENTED_BEHAVIOUR_CONFLICT_UNGROUNDED: ${at}.documentation.text must be an exact excerpt of ${path} lines ${startLine}-${endLine}`);
    return { ...conflict, code, documentation } as T;
  });
}

/** A Feature conflict must also name recorded requirements. */
export function groundRequirementConflicts(conflicts: readonly RequirementBehaviourConflict[], requirementIds: ReadonlySet<string>, snapshot: RepositorySnapshot, request: string): RequirementBehaviourConflict[] {
  for (const [index, conflict] of conflicts.entries()) {
    const unknown = conflict.requirementIds.filter((id) => !requirementIds.has(id));
    if (unknown.length > 0) throw new Error(`DOCUMENTED_BEHAVIOUR_CONFLICT_UNKNOWN_REQUIREMENT: documentedBehaviourConflicts[${index}].requirementIds names ${unknown.join(", ")}, which are not recorded requirement IDs`);
  }
  return groundBehaviourConflicts(conflicts, snapshot, request);
}

export const DOCUMENTED_BEHAVIOUR_CONFLICT = "documented_behaviour_conflict";

/** A stable reason naming the contradicting code. */
export function conflictReason(conflict: DocumentedBehaviourConflict): string {
  return `${DOCUMENTED_BEHAVIOUR_CONFLICT}:${conflict.code.path}:${conflict.code.startLine}`;
}

/** An exact excerpt of the cited lines; a miscounted range is anchored or widened to its quotation. */
function groundQuote(quote: LineEvidence, file: SnapshotFile | undefined): LineEvidence | null {
  if (file === undefined || quote.text.trim() === "") return null;
  const exact = { path: quote.path, startLine: quote.startLine, endLine: quote.endLine, text: quote.text };
  if (quote.endLine >= quote.startLine && quote.endLine <= file.lines.length && file.lines.slice(quote.startLine - 1, quote.endLine).join("\n").includes(quote.text)) return exact;
  const anchored = anchorLineEvidence(exact, file);
  if (anchored !== null) return anchored;
  const widened = widenToQuote(exact, quote.text, file);
  return widened === null ? null : { ...exact, ...widened };
}
