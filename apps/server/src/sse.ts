export interface SseReply { raw: { write(chunk: string): boolean; end(): void; on(event: "close", listener: () => void): void }; header(name: string, value: string): void }
export async function streamSse<T>(reply: SseReply, events: AsyncIterable<T>, signal?: AbortSignal): Promise<void> {
  reply.header("Content-Type", "text/event-stream"); reply.header("Cache-Control", "no-cache"); reply.header("Connection", "keep-alive");
  let closed = false; reply.raw.on("close", () => { closed = true; });
  for await (const event of events) { if (closed || signal?.aborted === true) break; reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); await yieldEventLoop(); }
  if (!closed) reply.raw.end();
}
export function yieldEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

