import { vi } from "vitest";
import { DETAILS_OVERLAY_QUERY } from "../src/app/media.js";

/**
 * A stand-in control plane for page tests. Routes are keyed `METHOD /path` (a trailing `*`
 * matches any suffix, such as a query string); every request is logged as `METHOD /path`.
 * An unrouted request answers 404 with a message naming it, so a missing stub fails loudly.
 */
export type Handler = (request: { readonly method: string; readonly path: string; readonly body: unknown }) => unknown;
export function stubControlPlane(routes: Readonly<Record<string, unknown>>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const key = `${method} ${path}`;
    calls.push(key);
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const handler = Object.hasOwn(routes, key) ? routes[key] : Object.entries(routes).find(([pattern]) => pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))?.[1];
    if (handler === undefined) return json({ statusCode: 404, error: "REQUEST_FAILED", message: `NO_STUB:${key}` }, 404);
    const value = typeof handler === "function" ? await (handler as Handler)({ method, path, body }) : handler;
    return value instanceof Response ? value : json(value);
  });
  return calls;
}

/** Browser surfaces jsdom lacks: React Flow's ResizeObserver, the run event stream, media queries. */
export function stubBrowser({ narrow = false }: { readonly narrow?: boolean } = {}): void {
  class Observer { observe(): void {} unobserve(): void {} disconnect(): void {} }
  class Source { onmessage: unknown = null; onerror: unknown = null; constructor(readonly url: string) {} addEventListener(): void {} close(): void {} }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow && query === DETAILS_OVERLAY_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

export function visit(search: string): void { window.history.replaceState(null, "", `/${search}`); }
export function address(): URLSearchParams { return new URLSearchParams(window.location.search); }
export function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
