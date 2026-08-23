import type { HarnessMode, HarnessProfile, HarnessRequirements } from "./profile.js";

export interface HarnessPrompt { readonly text: string; readonly hash: string }
export interface HarnessNode { readonly id: string; readonly modelId: string; readonly maximumOutputTokens: number; readonly maxToolTurns: number }
export interface HarnessToolDefinition { readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>> }
export interface HarnessToolRuntime { invoke(name: string, args: unknown, context: HarnessToolContext): Promise<HarnessToolResult> }
export interface HarnessToolContext {
  readonly nodeId: string; readonly responseFormat?: "text" | "json"; readonly maxCallBytes?: number;
  readonly protect: (content: string, meta: { readonly sourceId: string; readonly path?: string }) => string;
  readonly moduleForPath?: (path: string) => string | null;
  readonly riskSurfacesForPath?: (path: string) => readonly string[];
}
export interface HarnessToolResult { readonly ok: boolean; readonly summary: string; readonly content: string; readonly artifact: string | null; readonly truncated: boolean; readonly trust: "untrusted"; readonly error?: { readonly code: string; readonly message: string } }
export interface HarnessModelRequest { readonly modelId: string; readonly messages: readonly HarnessMessage[]; readonly tools: readonly HarnessToolDefinition[]; readonly maximumOutputTokens: number }
export interface HarnessMessage { readonly role: "system" | "user" | "assistant" | "tool"; readonly content: string; readonly toolCallId?: string }
export interface HarnessToolCall { readonly id: string; readonly name: string; readonly arguments: unknown }
export interface HarnessUsage { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cacheReadTokens: number | null; readonly cacheWriteTokens: number | null }
export interface HarnessModelResponse { readonly text: string | null; readonly toolCalls: readonly HarnessToolCall[]; readonly refusal: string | null; readonly usage: HarnessUsage }
export interface HarnessProviderRuntime { invoke(request: HarnessModelRequest, context: { readonly nodeId: string; readonly turn: number; readonly promptHash: string; readonly signal: AbortSignal }): Promise<HarnessModelResponse> }
export interface HarnessRunPolicy { readonly mode: HarnessMode; readonly round: number; readonly requirements: HarnessRequirements; readonly signal: AbortSignal; readonly toolContext: Omit<HarnessToolContext, "nodeId"> }
export type HarnessEvent =
  | { readonly type: "model_turn_started"; readonly nodeId: string; readonly turn: number }
  | { readonly type: "model_turn_completed"; readonly nodeId: string; readonly turn: number; readonly usage: HarnessUsage }
  | { readonly type: "tool_call"; readonly nodeId: string; readonly turn: number; readonly call: HarnessToolCall }
  | { readonly type: "tool_result"; readonly nodeId: string; readonly turn: number; readonly callId: string; readonly result: HarnessToolResult }
  | { readonly type: "completed"; readonly nodeId: string; readonly turns: number; readonly text: string | null; readonly refusal: string | null };
export interface HarnessRun { readonly events: AsyncIterable<HarnessEvent> }
export interface HarnessAdapter { readonly profile: HarnessProfile; run(node: HarnessNode, prompt: HarnessPrompt, tools: readonly HarnessToolDefinition[], toolRuntime: HarnessToolRuntime, policy: HarnessRunPolicy): HarnessRun }
