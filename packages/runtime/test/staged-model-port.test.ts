import { describe, expect, it } from "vitest";
import type { PinnedProtocol } from "@arbitra/protocols/registry.js";
import type { ModelActivityRequest } from "../src/model-activities.js";
import type { ModelHarness } from "../src/model-harness.js";
import type { RunStore } from "../src/run-store.js";
import { harnessStagePort } from "../src/staged-model-port.js";

describe("the staged port for Feature and Testing stages", () => {
  it("composes a repair again with less optional source, so what the repair adds fits", async () => {
    // Observed live (P20 pilot) in the audit pipeline: a request packed to its limit failed the run when its repair
    // added the validator's reason and the rejected reply. The staged port now refits a repair as the pipeline does.
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ path, lines: ["x".repeat(1_000)], lineStartBytes: [0], byteLength: 1_000 }));
    const size = (request: Pick<ModelActivityRequest<unknown>, "messages">) => JSON.stringify(request.messages).length;
    let sent: ModelActivityRequest<unknown> | undefined;
    const harness = {
      outputLimited: async () => false, withinInputBudget: () => true, estimateInitialTokens: (request: ModelActivityRequest<unknown>) => size(request),
      invoke: async (request: ModelActivityRequest<unknown>) => { sent = request; return { done: true }; },
    } as unknown as ModelHarness;
    const protocol = { protocolId: "planner", protocolVersion: "1", protocolHash: "0".repeat(64), content: "" } as unknown as PinnedProtocol;
    const port = harnessStagePort({ store: { publish: async () => undefined } as unknown as RunStore, harness, snapshot: { root: "fixture", files }, protocol, modelProfileId: "model",
      signal: new AbortController().signal, maximumInputTokens: 4_000, stagePrefix: "feature/planner", instructionSuffix: "", artifactPrefix: "feature-", nodeId: "planner",
      full: { stageActivityId: "full", activityId: "feature/planner", instruction: "Plan.", input: { request: "r" }, schema: { parse: (value: unknown) => value }, outputSchema: {}, contextArtifact: "planner-context" } });
    await port.call({ activityId: "full", instruction: "Plan.", input: { request: "r" }, schema: { parse: (value: unknown) => value }, jsonSchema: {} } as never);
    if (sent?.refit === undefined) throw new Error("REFIT_ABSENT");
    expect(size(sent)).toBeLessThanOrEqual(4_000);
    const appended = [{ role: "user" as const, content: "y".repeat(1_500) }];
    const repaired = await sent.refit(appended, "feature/planner/repair-1");
    // The repair keeps its own messages whole, within the same limit, and carries fewer source files to make room.
    expect(repaired.messages.slice(-1)).toEqual(appended);
    expect(size(repaired)).toBeLessThanOrEqual(4_000);
    const carried = (messages: readonly { content: unknown }[]) => (JSON.parse(String(messages[1]?.content)) as { repository: unknown[] }).repository.length;
    expect(carried(repaired.messages)).toBeLessThan(carried(sent.messages));
  });
});
