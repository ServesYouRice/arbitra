import type { CritiqueItem } from "./critic/node.js";

export interface RevisionResolution { readonly critiqueItemId: string; readonly resolution: string }
export interface RevisionOutput<TPlan> { readonly plan: TPlan; readonly resolutions: readonly RevisionResolution[] }
export interface RevisionRequest<TPlan> { readonly originalGoal: string; readonly originalPlan: TPlan; readonly blockingCritique: readonly CritiqueItem[]; readonly plannerConfiguration: Readonly<Record<string, unknown>> }
export interface RevisionRuntime<TPlan> { revise(request: RevisionRequest<TPlan>): Promise<RevisionOutput<TPlan>> }

export async function revisePlanOnce<TPlan>(
  originalGoal: string,
  plan: TPlan,
  critique: readonly CritiqueItem[],
  plannerConfiguration: Readonly<Record<string, unknown>>,
  runtime: RevisionRuntime<TPlan>,
): Promise<{ readonly plan: TPlan; readonly resolutions: readonly RevisionResolution[]; readonly revisionCalls: 0 | 1 }> {
  const blocking = critique.filter(({ blocking }) => blocking);
  if (blocking.length === 0) return Object.freeze({ plan, resolutions: Object.freeze([]), revisionCalls: 0 as const });
  const revised = await runtime.revise(Object.freeze({ originalGoal, originalPlan: plan, blockingCritique: Object.freeze(blocking), plannerConfiguration }));
  const expected = new Set(blocking.map(({ id }) => id));
  const resolved = new Set(revised.resolutions.map(({ critiqueItemId }) => critiqueItemId));
  if (resolved.size !== expected.size || revised.resolutions.length !== expected.size || [...expected].some((id) => !resolved.has(id)) || revised.resolutions.some(({ critiqueItemId, resolution }) => !expected.has(critiqueItemId) || resolution.trim() === "")) throw new Error("REVISION_DID_NOT_RESOLVE_EVERY_BLOCKING_CRITIQUE_ITEM");
  return Object.freeze({ plan: revised.plan, resolutions: Object.freeze([...revised.resolutions]), revisionCalls: 1 as const });
}
