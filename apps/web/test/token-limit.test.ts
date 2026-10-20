import { expect, it } from "vitest";
import { raisedTokenLimit, recommendedTokenLimit, tokens } from "../src/app/token-limit.js";

it("sizes a run's token limit to the project, with a floor, and raises a paused one by half", () => {
  expect(recommendedTokenLimit(11_291, 3)).toBe(40_000_000);
  expect(recommendedTokenLimit(500, 3)).toBe(20_000_000);
  expect(recommendedTokenLimit(11_291, 2)).toBe(30_000_000);
  expect(raisedTokenLimit(40_000_000)).toBe(60_000_000);
  expect(tokens(40_000_000)).toBe("40M");
});
