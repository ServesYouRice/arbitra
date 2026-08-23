import type { DialectPolicy } from "../types.js";

export const openaiStrictPolicy: DialectPolicy = {
  dialect: "openai_strict",
  maxNestingDepth: 5,
};
