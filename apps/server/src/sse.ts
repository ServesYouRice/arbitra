export interface SseReply {
  raw: { write(chunk: string): boolean; end(): void; on(event: "close" | "drain", listener: () => void): void; off?(event: "close" | "drain", listener: () => void): void; writeHead?(status: number, headers: Record<string, string>): unknown };
  header(name: string, value: string): void;
  hijack?(): unknown;
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
  reply.hijack?.();
  reply.raw.writeHead?.(200, { ...SSE_HEADERS });
  let closed = signal?.aborted === true;
  let socketClosed = false;
  let stop: (() => void) | undefined;
  const close = (): void => { closed = true; stop?.(); };
  const socketClose = (): void => { socketClosed = true; close(); };
  let drain: (() => void) | undefined;
  const drained = (): void => { drain?.(); drain = undefined; };
  reply.raw.on("close", socketClose);
  reply.raw.on("drain", drained);
  signal?.addEventListener("abort", close, { once: true });

  const iterator = events[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (!closed) {
      // Only one close waiter exists at a time. Racing every event against one
      // unresolved promise retains a callback for every event until disconnection.
      const outcome = await new Promise<{ kind: "next"; result: IteratorResult<T> } | { kind: "stop" }>((resolve, reject) => {
        stop = () => resolve({ kind: "stop" });
        void iterator.next().then((result) => resolve({ kind: "next", result }), reject);
      }).finally(() => { stop = undefined; });
      if (closed || outcome.kind === "stop") break;
      if (outcome.result.done === true) { finished = true; break; }
      if (!reply.raw.write(`data: ${JSON.stringify(outcome.result.value)}\n\n`)) {
        if (!closed) await new Promise<void>((resolve) => { drain = resolve; stop = resolve; }).finally(() => { drain = undefined; stop = undefined; });
      }
      await yieldEventLoop();
    }
    if (!closed && finished) reply.raw.write("event: end\ndata: {}\n\n");
  } finally {
    signal?.removeEventListener("abort", close);
    reply.raw.off?.("close", socketClose);
    reply.raw.off?.("drain", drained);
    if (!finished) void Promise.resolve(iterator.return?.()).catch(() => undefined);
    if (!socketClosed) reply.raw.end();
  }
}
export function yieldEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
