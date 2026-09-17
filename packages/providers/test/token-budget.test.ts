import { describe, expect, it } from "vitest";
import { DurableTokenBudget, type TokenBudgetBackend } from "../src/token-budget.js";

const usage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 };
function backend(): TokenBudgetBackend {
  let stored: unknown = null;
  return { async load() { return structuredClone(stored); }, async save(state) { stored = structuredClone(state); } };
}

describe("durable token budget", () => {
  it("serializes concurrent admissions and preserves interrupted charges across restart", async () => {
    const disk = backend();
    const budget = new DurableTokenBudget(10, disk);
    const results = await Promise.all([budget.reserve("a", 6), budget.reserve("b", 6)]);
    expect(results.map(({ allowed }) => allowed)).toEqual([true, false]);
    expect(await new DurableTokenBudget(10, disk).reserve("a", 6)).toMatchObject({ allowed: false });
  });

  it("settles each retry separately using actual usage without double charging cache tokens", async () => {
    const disk = backend();
    const budget = new DurableTokenBudget(20, disk);
    const first = await budget.reserve("a", 10);
    const second = await budget.reserve("a", 10);
    await budget.recordActual("a", usage, second.reservationId);
    await budget.recordActual("a", usage, second.reservationId);
    expect(await new DurableTokenBudget(20, disk).reserve("next", 5)).toMatchObject({ allowed: true });
    expect(first.reservationId).not.toBe(second.reservationId);
    await expect(budget.recordActual("other", usage, first.reservationId)).rejects.toThrow("UNKNOWN_TOKEN_RESERVATION");
  });

  it("retains estimated charges when usage is partial and never discards known overruns", async () => {
    const budget = new DurableTokenBudget(20, backend());
    const first = await budget.reserve("a", 10);
    await budget.recordActual("a", { ...usage, inputTokens: 25, outputTokens: null }, first.reservationId);
    expect(await budget.reserve("b", 1)).toMatchObject({ allowed: false });
  });

  it("does not admit calls when persistence fails, and retries safely", async () => {
    const disk = backend();
    let fail = true;
    const budget = new DurableTokenBudget(10, { load: disk.load, async save(state) { if (fail) throw new Error("disk full"); await disk.save(state); } });
    await expect(budget.reserve("a", 10)).rejects.toThrow("disk full");
    fail = false;
    expect(await budget.reserve("a", 10)).toMatchObject({ allowed: true, reservationId: "reservation-1" });
  });

  it("fails closed on corrupt state and changed limits", async () => {
    const disk = backend();
    await new DurableTokenBudget(10, disk).reserve("a", 5);
    await expect(new DurableTokenBudget(20, disk).reserve("a", 5)).rejects.toThrow("INVALID_TOKEN_BUDGET_STATE");
    const corrupt = new DurableTokenBudget(10, { async load() { return { schemaVersion: 1, maximumTokens: 10, reservations: [null] }; }, async save() {} });
    await expect(corrupt.reserve("a", 5)).rejects.toThrow("INVALID_TOKEN_BUDGET_STATE");
  });
});
