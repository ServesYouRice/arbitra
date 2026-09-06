import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { streamSse, type SseReply } from "../src/sse.js";

describe("SSE lifecycle", () => {
  it("waits for socket backpressure and removes its listeners", async () => {
    const socket = new EventEmitter();
    const chunks: string[] = [];
    let read = 0;
    const ended = vi.fn();
    const reply: SseReply = { header() {}, raw: {
      write(chunk) { chunks.push(chunk); return chunks.length !== 1; }, end: ended,
      on(event, listener) { socket.on(event, listener); }, off(event, listener) { socket.off(event, listener); },
    } };
    async function* events() { read += 1; yield { step: 1 }; read += 1; yield { step: 2 }; }
    const pending = streamSse(reply, events());
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    expect(read).toBe(1);
    socket.emit("drain");
    await pending;
    expect(read).toBe(2); expect(ended).toHaveBeenCalledOnce();
    expect(socket.listenerCount("drain")).toBe(0); expect(socket.listenerCount("close")).toBe(0);
    expect(chunks.at(-1)).toBe("event: end\ndata: {}\n\n");
  });

  it("releases a subscriber when the client leaves during an idle stream", async () => {
    const socket = new EventEmitter();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<unknown> = { [Symbol.asyncIterator]() { return { next: async () => new Promise(() => {}), return: returned }; } };
    const reply: SseReply = { header() {}, raw: { write: () => true, end() {}, on(event, listener) { socket.on(event, listener); }, off(event, listener) { socket.off(event, listener); } } };
    const pending = streamSse(reply, source);
    socket.emit("close");
    await pending;
    expect(returned).toHaveBeenCalledOnce();
  });
});
