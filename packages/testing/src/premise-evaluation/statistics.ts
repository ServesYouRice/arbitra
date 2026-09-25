/** A proportion with its denominator and a Wilson score interval. An empty denominator is null, never zero. */
export interface Proportion { readonly successes: number; readonly trials: number; readonly estimate: number | null; readonly interval: readonly [number, number] | null }

export function wilson(successes: number, trials: number, confidence: number): Proportion {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(trials) || successes < 0 || trials < 0 || successes > trials) throw new Error(`INVALID_PROPORTION:${successes}/${trials}`);
  if (trials === 0) return Object.freeze({ successes, trials, estimate: null, interval: null });
  const z = normalQuantile(1 - (1 - confidence) / 2); const p = successes / trials; const z2 = z * z;
  const centre = (p + z2 / (2 * trials)) / (1 + z2 / trials);
  const half = (z / (1 + z2 / trials)) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Object.freeze({ successes, trials, estimate: round(p), interval: Object.freeze([round(Math.max(0, centre - half)), round(Math.min(1, centre + half))] as const) });
}

/** Deterministic PRNG (mulberry32), so a bootstrap is reproducible from the protocol seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}

export interface PairedDifference { readonly estimate: number | null; readonly interval: readonly [number, number] | null; readonly units: number; readonly iterations: number }

/**
 * Percentile bootstrap of mean(a) − mean(b) over paired units (for recall: one unit per
 * ground-truth defect, 1 when the condition detected it). Units are resampled with replacement.
 */
export function pairedBootstrap(pairs: readonly (readonly [number, number])[], iterations: number, seed: number, confidence: number): PairedDifference {
  if (pairs.length === 0) return Object.freeze({ estimate: null, interval: null, units: 0, iterations });
  const random = seededRandom(seed); const differences: number[] = [];
  const mean = (values: readonly (readonly [number, number])[]) => values.reduce((sum, [a, b]) => sum + a - b, 0) / values.length;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from({ length: pairs.length }, () => pairs[Math.floor(random() * pairs.length)] as readonly [number, number]);
    differences.push(mean(sample));
  }
  differences.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2; const at = (q: number) => differences[Math.min(differences.length - 1, Math.max(0, Math.floor(q * differences.length)))] ?? 0;
  return Object.freeze({ estimate: round(mean(pairs)), interval: Object.freeze([round(at(tail)), round(at(1 - tail))] as const), units: pairs.length, iterations });
}

/** Acklam's rational approximation of the standard normal quantile. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("INVALID_QUANTILE");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const poly = (coefficients: readonly number[], x: number) => coefficients.reduce((sum, value) => sum * x + value, 0);
  const low = 0.02425;
  if (p < low) { const q = Math.sqrt(-2 * Math.log(p)); return poly(c, q) / (poly(d, q) * q + 1); }
  if (p > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -poly(c, q) / (poly(d, q) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

export function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
