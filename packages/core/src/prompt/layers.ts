export interface ProtocolPin { readonly protocolId: string; readonly protocolVersion: string; readonly protocolHash: string }
export interface UntrustedPromptInput { readonly content: string; readonly sourceId: string; readonly path?: string }
export interface PromptSecurityBoundary {
  redact(text: string): { readonly text: string; readonly redactionCount: number };
  frame(text: string, meta: { readonly sourceId: string; readonly path?: string }): string;
}
export interface PromptCompileSpec {
  readonly protocol: ProtocolPin & { readonly content: string };
  readonly outputSchema: unknown;
  readonly toolDefinitions: unknown;
  readonly projectContext: unknown;
  readonly stableRepositoryArtifacts: readonly UntrustedPromptInput[];
  readonly roundArtifacts: readonly UntrustedPromptInput[];
  readonly overrides: { readonly before?: string; readonly after?: string };
  readonly instruction: string;
  readonly outputContract: string;
  readonly nodeId: string;
  readonly modelId: string;
  readonly security: PromptSecurityBoundary;
}
export const PROMPT_LAYER_ORDER = Object.freeze(["locked", "stable_repository", "round", "overrides", "instruction"] as const);
export type PromptLayerName = typeof PROMPT_LAYER_ORDER[number];
export interface PromptLayer { readonly layer: PromptLayerName; readonly value: unknown }
