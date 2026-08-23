export interface Clock {
  now(): number;
}

/** Wall-clock adapter. Workflow callers must invoke it from an activity callback. */
export class SystemClock implements Clock {
  now(): number {
    // arbitra-determinism: allow -- real clock adapter boundary
    return Date.now();
  }
}

/** Deterministic clock for tests and replay-oriented callers. */
export class FixedClock implements Clock {
  readonly #timestamp: number;

  constructor(timestamp: number) {
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("Clock timestamp must be finite");
    }
    this.#timestamp = timestamp;
  }

  now(): number {
    return this.#timestamp;
  }
}
