import type { DialectPolicy } from "../types.js";

export const anthropicToolPolicy: DialectPolicy = {
  dialect: "anthropic_tool",
  maxNestingDepth: 5,
};
