import { describe, expect, it } from "vitest";
import { firstThenSideBySide, sharedLimit, sideBySide } from "../src/side-by-side.js";

const later = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("independent work side by side", () => {
  it("keeps to the limit and returns the results in item order whichever finishes first", async () => {
    let active = 0; let most = 0;
    const results = await sideBySide([30, 5, 20, 1, 10], 2, async (milliseconds, index) => {
      active += 1; most = Math.max(most, active);
      await later(milliseconds);
      active -= 1;
      return `${index}:${milliseconds}`;
    });
    expect(most).toBe(2);
    expect(results).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
    expect(await sideBySide([], 4, async () => 1)).toEqual([]);
  });

  it("can finish the first item before the others start, so the prompt cache they share is written, and keeps the order and the limit", async () => {
    const events: string[] = []; let active = 0; let most = 0;
    const results = await firstThenSideBySide([10, 5, 5, 5, 5], 3, async (milliseconds, index) => {
      events.push(`start ${index}`); active += 1; most = Math.max(most, active);
      await later(milliseconds);
      active -= 1; events.push(`end ${index}`);
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(events.slice(0, 2)).toEqual(["start 0", "end 0"]);
    expect(most).toBe(3);
    // Nothing to wait for with one item or one call at a time; a failure of the first item starts no other.
    expect(await firstThenSideBySide([7], 4, async (item) => item)).toEqual([7]);
    const started: number[] = [];
    await expect(firstThenSideBySide([0, 1, 2], 2, async (item) => { started.push(item); if (item === 0) throw new Error("FIRST_FAILED"); })).rejects.toThrow("FIRST_FAILED");
    expect(started).toEqual([0]);
    await expect(firstThenSideBySide([1], 0, async () => 1)).rejects.toThrow("INVALID_PARALLEL_CALLS");
  });

  it("starts nothing new after a failure, lets the work in flight end, and reports the first failure in item order", async () => {
    const started: number[] = []; const finished: number[] = [];
    await expect(sideBySide([0, 1, 2, 3, 4, 5], 3, async (item) => {
      started.push(item);
      // Item 2 fails first in time; item 1 fails later but comes first in item order.
      if (item === 2) { await later(5); throw new Error("SECOND_IN_ORDER"); }
      if (item === 1) { await later(20); throw new Error("FIRST_IN_ORDER"); }
      await later(10); finished.push(item);
    })).rejects.toThrow("FIRST_IN_ORDER");
    expect(started).toEqual([0, 1, 2]);
    expect(finished).toEqual([0]);
  });

  it("is a plain loop at a limit of one and refuses a limit that is not a positive whole number", async () => {
    const order: number[] = [];
    await expect(sideBySide([1, 2, 3], 1, async (item) => { order.push(item); if (item === 2) throw new Error("STOPPED"); })).rejects.toThrow("STOPPED");
    expect(order).toEqual([1, 2]);
    await expect(sideBySide([1], 0, async () => 1)).rejects.toThrow("INVALID_PARALLEL_CALLS");
    await expect(sideBySide([1], 1.5, async () => 1)).rejects.toThrow("INVALID_PARALLEL_CALLS");
  });

  it("keeps nested work within one shared limit, in the order calls asked, and frees a place after a failure", async () => {
    const limit = sharedLimit(2);
    let active = 0; let most = 0; const order: string[] = [];
    const call = (label: string, fails = false) => limit(async () => {
      active += 1; most = Math.max(most, active); order.push(label);
      try { await later(5); if (fails) throw new Error(`FAILED:${label}`); return label; }
      finally { active -= 1; }
    });
    // Each item makes a call, then two side by side of its own, as a discovery unit that splits does.
    const nested = (item: string) => call(item).then(() => sideBySide([1, 2], 2, (part) => call(`${item}${part}`)));
    expect(await sideBySide(["a", "b"], 2, nested)).toEqual([["a1", "a2"], ["b1", "b2"]]);
    expect(most).toBe(2);
    expect(order).toEqual(["a", "b", "a1", "a2", "b1", "b2"]);
    await expect(call("c", true)).rejects.toThrow("FAILED:c");
    expect(await sideBySide(["d", "e", "f"], 3, (item) => call(item))).toEqual(["d", "e", "f"]);
    expect(most).toBe(2);
    expect(() => sharedLimit(0)).toThrow("INVALID_PARALLEL_CALLS");
  });
});
