import { describe, expect, it } from "vitest";
import type { TransportMessage } from "@arbitra/providers/transport-contract.js";
import { boundModelHistory } from "../src/model-history.js";

const initial: TransportMessage[] = [{ role: "system", content: "Locked instructions and evidence" }];
const exchange = (id: string, size: number): TransportMessage[] => [{ role: "assistant", content: "", toolCalls: [{ id, name: "repo_read_file", arguments: { path: "a.ts" } }] }, { role: "tool", toolCallId: id, toolName: "repo_read_file", content: "x".repeat(size) }];

describe("bounded tool history", () => {
  it("archives whole older exchanges and keeps recent call/result pairs intact", async () => {
    const old = exchange("old", 3000); const recent = exchange("recent", 20); const archived: string[] = [];
    const result = await boundModelHistory(initial, [...old, ...recent], (messages) => JSON.stringify(messages).length <= 1300, async (content) => { archived.push(content); return "activity-local-ref"; });
    expect(result.archiveRef).toBe("activity-local-ref");
    expect(result.archivedMessages).toBe(2);
    expect(JSON.parse(archived[0] ?? "null")).toEqual(old);
    expect(result.messages[0]).toEqual(initial[0]);
    expect(result.messages.slice(-2)).toEqual(recent);
    expect(result.messages[1]?.content).toContain('trust="untrusted"');
  });

  it("can archive the latest complete exchange if needed without dropping the instructions", async () => {
    const result = await boundModelHistory(initial, exchange("only", 3000), (messages) => JSON.stringify(messages).length <= 1000, async () => "ref");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual(initial[0]);
    expect(result.messages[1]?.role).toBe("user");
  });

  it("does not archive fitting history and rejects incomplete tool exchanges", async () => {
    const history = exchange("fits", 5);
    expect((await boundModelHistory(initial, history, () => true, async () => { throw new Error("archive called"); })).archiveRef).toBeNull();
    await expect(boundModelHistory(initial, history.slice(0, 1), () => false, async () => "ref")).rejects.toThrow("INCOMPLETE_TOOL_HISTORY_EXCHANGE");
    await expect(boundModelHistory(initial, [], () => false, async () => "ref")).rejects.toThrow("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
  });
});
