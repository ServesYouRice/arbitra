import { describe, expect, it } from "vitest";
import { sideBySide } from "../src/side-by-side.js";

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
});
