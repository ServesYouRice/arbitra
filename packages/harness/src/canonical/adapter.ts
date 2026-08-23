import type { HarnessAdapter, HarnessEvent, HarnessMessage, HarnessModelResponse, HarnessNode, HarnessPrompt, HarnessProviderRuntime, HarnessRun, HarnessRunPolicy, HarnessToolDefinition, HarnessToolRuntime } from "../adapter.js";
import { assertHarnessCompatible, assertRoundZeroPolicy, CANONICAL_HARNESS_PROFILE, type HarnessProfile } from "../profile.js";

export class CanonicalHarnessAdapter implements HarnessAdapter {
  readonly profile: HarnessProfile;
  constructor(private readonly providerRuntime: HarnessProviderRuntime, profile: HarnessProfile = CANONICAL_HARNESS_PROFILE) { this.profile = profile; }

  run(node: HarnessNode, prompt: HarnessPrompt, tools: readonly HarnessToolDefinition[], toolRuntime: HarnessToolRuntime, policy: HarnessRunPolicy): HarnessRun {
    assertHarnessCompatible(this.profile, policy.mode, policy.requirements);
    if (policy.round === 0) assertRoundZeroPolicy(this.profile);
    if (!Number.isSafeInteger(node.maxToolTurns) || node.maxToolTurns < 0) throw new Error("INVALID_MODEL_TOOL_LOOP_LIMIT");
    return Object.freeze({ events: this.execute(node, prompt, tools, toolRuntime, policy) });
  }

  private async *execute(node: HarnessNode, prompt: HarnessPrompt, tools: readonly HarnessToolDefinition[], toolRuntime: HarnessToolRuntime, policy: HarnessRunPolicy): AsyncGenerator<HarnessEvent> {
    const messages: HarnessMessage[] = [{ role: "user", content: prompt.text }];
    let response: HarnessModelResponse | null = null;
    for (let turn = 0; turn <= node.maxToolTurns; turn += 1) {
      if (policy.signal.aborted) throw policy.signal.reason;
      yield Object.freeze({ type: "model_turn_started", nodeId: node.id, turn });
      response = await this.providerRuntime.invoke(Object.freeze({ modelId: node.modelId, messages: Object.freeze([...messages]), tools, maximumOutputTokens: node.maximumOutputTokens }), { nodeId: node.id, turn, promptHash: prompt.hash, signal: policy.signal });
      yield Object.freeze({ type: "model_turn_completed", nodeId: node.id, turn, usage: response.usage });
      if (response.toolCalls.length === 0) {
        yield Object.freeze({ type: "completed", nodeId: node.id, turns: turn + 1, text: response.text, refusal: response.refusal }); return;
      }
      if (turn === node.maxToolTurns) throw new Error(`HARNESS_TOOL_LOOP_LIMIT:${node.maxToolTurns}`);
      messages.push({ role: "assistant", content: response.text ?? "" });
      for (const call of response.toolCalls) {
        yield Object.freeze({ type: "tool_call", nodeId: node.id, turn, call });
        const result = await toolRuntime.invoke(call.name, call.arguments, { nodeId: node.id, ...policy.toolContext });
        yield Object.freeze({ type: "tool_result", nodeId: node.id, turn, callId: call.id, result });
        messages.push({ role: "tool", content: result.content, toolCallId: call.id });
      }
    }
    throw new Error("HARNESS_LOOP_UNREACHABLE");
  }
}
