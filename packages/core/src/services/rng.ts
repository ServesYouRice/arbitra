export interface Rng {
  forActivity(activityId: string): Rng;
  int(maxExclusive: number): number;
  shuffle<T>(items: T[]): T[];
}

const UINT32_RANGE = 0x1_0000_0000;

/**
 * A small deterministic PRNG whose seed is derived from run and activity identity.
 * It is intended for reproducible workflow ordering, not cryptography.
 */
export class SeededRng implements Rng {
  readonly #runId: string;
  #state: number;

  constructor(runId: string, activityId = "") {
    if (runId.length === 0) throw new RangeError("runId must not be empty");
    this.#runId = runId;
    this.#state = hashSeed(runId, activityId);
  }

  forActivity(activityId: string): Rng {
    if (activityId.length === 0) throw new RangeError("activityId must not be empty");
    return new SeededRng(this.#runId, activityId);
  }

  int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
      throw new RangeError("maxExclusive must be a positive safe integer no greater than 2^32");
    }
    return Math.floor((this.#nextUint32() * maxExclusive) / UINT32_RANGE);
  }

  shuffle<T>(items: T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = this.int(index + 1);
      [result[index], result[other]] = [result[other] as T, result[index] as T];
    }
    return result;
  }

  #nextUint32(): number {
    let value = (this.#state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }
}

function hashSeed(runId: string, activityId: string): number {
  const input = `${runId.length}:${runId}${activityId.length}:${activityId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
