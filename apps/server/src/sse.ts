export interface SseReply {
  raw: { write(chunk: string): boolean; end(): void; on(event: "close", listener: () => void): void; writeHead?(status: number, headers: Record<string, string>): unknown };
  header(name: string, value: string): void;
}
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
/**
 * Stream an async iterable as Server-Sent Events.
 *
 * The headers go out on the raw socket, not through `reply.header`: this handler writes
 * its body with `reply.raw.write`, which bypasses Fastify's own header flush, so a reply
 * header set here would never reach the client. Without `text/event-stream` the browser's
 * EventSource rejects the response and the caller sees a run that never starts.
 */
export async function streamSse<T>(reply: SseReply, events: AsyncIterable<T>, signal?: AbortSignal): Promise<void> {
  for (const [name, value] of Object.entries(SSE_HEADERS)) reply.header(name, value);
  reply.raw.writeHead?.(200, { ...SSE_HEADERS });
  let closed = false; reply.raw.on("close", () => { closed = true; });
  for await (const event of events) { if (closed || signal?.aborted === true) break; reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); await yieldEventLoop(); }
  if (!closed) reply.raw.end();
}
export function yieldEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

