import type { TransportMessage } from "@arbitra/providers/transport-contract.js";
import { frameUntrusted } from "@arbitra/security/framing";

/** Compact only complete exchanges; the original instructions/decision context stay
 * intact and the archived content remains available through activity-local tools. */
export async function boundModelHistory(initial: readonly TransportMessage[], history: readonly TransportMessage[], fits: (messages: readonly TransportMessage[]) => boolean, archive: (content: string) => Promise<string>): Promise<{ messages: readonly TransportMessage[]; archiveRef: string | null; archivedMessages: number }> {
  if (fits([...initial, ...history])) return { messages: [...initial, ...history], archiveRef: null, archivedMessages: 0 };
  const boundaries: number[] = [];
  let index = 0;
  while (index < history.length) {
    const assistant = history[index];
    if (assistant?.role !== "assistant" || (assistant.toolCalls?.length ?? 0) === 0) throw new Error("INVALID_TOOL_HISTORY_EXCHANGE");
    const remaining = new Set(assistant.toolCalls?.map(({ id }) => id));
    index += 1;
    while (index < history.length && history[index]?.role === "tool") {
      const id = history[index]?.toolCallId;
      if (id === undefined || !remaining.delete(id)) throw new Error("INVALID_TOOL_HISTORY_RESULT");
      index += 1;
    }
    if (remaining.size > 0) throw new Error("INCOMPLETE_TOOL_HISTORY_EXCHANGE");
    boundaries.push(index);
  }
  const marker = (ref: string, count: number): TransportMessage => ({ role: "user", content: frameUntrusted(JSON.stringify({ archivedToolMessages: count, artifact: ref, instruction: "Earlier tool exchanges were archived to fit context. Read this activity-local artifact or re-read source if the details are needed." }), { sourceId: "tool-history-archive" }) });
  for (const end of boundaries) {
    if (!fits([...initial, marker("x".repeat(160), end), ...history.slice(end)])) continue;
    const archiveRef = await archive(JSON.stringify(history.slice(0, end)));
    const messages = [...initial, marker(archiveRef, end), ...history.slice(end)];
    if (!fits(messages)) throw new Error("MODEL_HISTORY_REFERENCE_LIMIT_EXCEEDED");
    return { messages, archiveRef, archivedMessages: end };
  }
  throw new Error("MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED");
}
