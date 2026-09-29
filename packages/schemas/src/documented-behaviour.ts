import { z } from "zod";

const text = z.string().refine((value) => value.trim().length > 0, "Expected nonempty text");
const line = z.number().int().positive();

/**
 * Documentation that the current code contradicts. Current code shows what the code does, not
 * what it should do (observed live: a Testing writer pinned a seeded expiry bug as correct, and
 * a Feature requirements model wrote the same wrong contract twice). The documentation is a
 * repository excerpt, or a quotation of the request with a null path and null lines.
 */
const conflictShape = {
  documentation: z.strictObject({ path: text.nullable(), startLine: line.nullable(), endLine: line.nullable(), text }),
  code: z.strictObject({ path: text, startLine: line, endLine: line, text }),
  explanation: text,
};

function locatedTogether(value: { readonly documentation: { readonly path: string | null; readonly startLine: number | null; readonly endLine: number | null } }, context: z.RefinementCtx): void {
  const { path, startLine, endLine } = value.documentation;
  if ((path === null) !== (startLine === null) || (path === null) !== (endLine === null)) {
    context.addIssue({ code: "custom", path: ["documentation"], message: "A repository quotation needs path, startLine and endLine; a quotation of the request has all three null" });
  }
}

export const documentedBehaviourConflictSchema = z.strictObject(conflictShape).superRefine(locatedTogether);
export type DocumentedBehaviourConflict = z.infer<typeof documentedBehaviourConflictSchema>;

/** A Feature conflict also names the requirements that adopt the code's behaviour or leave it undecided. */
export const requirementBehaviourConflictSchema = z.strictObject({ requirementIds: z.array(text).min(1), ...conflictShape }).superRefine(locatedTogether);
export type RequirementBehaviourConflict = z.infer<typeof requirementBehaviourConflictSchema>;
