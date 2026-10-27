import type { StreamTrace } from "../../transport-contract.js";

/** How much of a CLI's stderr a failed call's trace keeps, from its end. */
const STDERR_TAIL_CHARACTERS = 2_000;

/**
 * What one CLI call's streams showed: each stdout event as it came (when, and its type), and the end of its stderr. A
 * failed call's attempt record keeps it, so a call that received nothing for 25 minutes reads apart from one that was
 * streaming when its time ran out. Observed (October 26, 2026, macOS): three calls timed out on every attempt while
 * the Mac slept, and nothing recorded either way; finding the cause took `pmset -g log`.
 */
export class StreamRecorder {
  readonly #now: () => number;
  readonly #startedAt: number;
  #events = 0;
  #lastAt: number | null = null;
  #lastType: string | null = null;
  #stderr = "";

  constructor(now: () => number) { this.#now = now; this.#startedAt = now(); }

  line(line: string): void { this.#events += 1; this.#lastAt = this.#now(); this.#lastType = eventType(line); }

  stderr(chunk: string): void { this.#stderr = (this.#stderr + chunk).slice(-2 * STDERR_TAIL_CHARACTERS); }

  /** The trace as the call stopped; `stderr` is the process's own capture, for a port that reports none as it comes. */
  trace(stderr = ""): StreamTrace {
    const iso = (at: number): string => new Date(at).toISOString();
    return Object.freeze({ startedAt: iso(this.#startedAt), stoppedAt: iso(this.#now()), events: this.#events, lastEventAt: this.#lastAt === null ? null : iso(this.#lastAt),
      lastEventType: this.#lastType, stderrTail: redactedTail(this.#stderr === "" ? stderr : this.#stderr) });
  }
}

/** An event's type and, when it wraps another, the inner one: `stream_event/content_block_delta`, `item.completed/agent_message`. */
export function eventType(line: string): string | null {
  const types = [...line.slice(0, 512).matchAll(/"type"\s*:\s*"([\w.:/-]{1,48})"/gu)].slice(0, 2).map((match) => match[1]);
  return types.length === 0 ? null : types.join("/");
}

/** The end of a CLI's stderr with anything credential-shaped removed, before it is cut, so no secret is cut past recognition. */
export function redactedTail(text: string, length = STDERR_TAIL_CHARACTERS): string {
  return text.replace(/(sk-(?:ant-[a-z0-9]+-|proj-)?|AIza|ya29\.|eyJ|gh[pousr]_)[A-Za-z0-9_.*-]{6,}/gu, "$1<redacted>").replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gu, "$1 <redacted>")
    .replace(/\b(key|token|secret|code|password)=[^\s&]+/giu, "$1=<redacted>").replace(/[\w.+-]+@[\w-]+\.[\w.]+/gu, "<email>").slice(-length);
}
