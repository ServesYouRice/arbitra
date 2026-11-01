/**
 * Runs independent work up to `limit` at a time and returns the results in the order of the items, so the
 * outcome does not depend on which item finishes first. After a failure no new item starts, the items in
 * flight run to their end, and the first failure in item order is reported. With a limit of 1 this is a
 * plain loop that stops at the first failure.
 *
 * Only work that reads nothing another item writes belongs here: the caller applies the results, in order,
 * after all of them are in.
 */
export async function sideBySide<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_PARALLEL_CALLS");
  const settled = new Map<number, { readonly value: R } | { readonly failure: unknown }>();
  let next = 0; let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next; next += 1;
      try { settled.set(index, { value: await run(items[index] as T, index) }); }
      catch (failure) { failed = true; settled.set(index, { failure }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const entry = settled.get(index);
    // Items are taken in order, so every item before the first failure has settled.
    if (entry === undefined) throw new Error("PARALLEL_CALL_OUTCOME_MISSING");
    if ("failure" in entry) throw entry.failure;
    results.push(entry.value);
  }
  return results;
}

/**
 * One allowance of `limit` calls in flight for work that nests `sideBySide`: an item that splits and runs its parts
 * side by side would otherwise start another `limit` of its own, so two items at a limit of two had four calls in
 * flight. Calls wait their turn in the order they asked; a call holds its place only while it runs.
 */
export function sharedLimit(limit: number): <R>(call: () => Promise<R>) => Promise<R> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_PARALLEL_CALLS");
  let running = 0; const waiting: (() => void)[] = [];
  return async (call) => {
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try { return await call(); }
    // The place passes straight to the next call waiting, so none can overtake it.
    finally { const next = waiting.shift(); if (next === undefined) running -= 1; else next(); }
  };
}
