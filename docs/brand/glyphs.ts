/**
 * arbitra node + state glyphs — the single source of truth.
 *
 * Destination: packages/schemas/src/glyphs.ts
 *
 * The CLI, the Markdown renderer and the graph view all import from here.
 * Two copies of this table is the same class of defect as two orchestrators.
 *
 * The node taxonomy is CLOSED (spec §8). Adding a seventh kind is a spec
 * change, not a UI change — which is exactly why this lives in schemas.
 */

export const NODE_KINDS = [
  "deterministic",
  "model",
  "gate",
  "loop",
  "human",
  "subgraph",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export interface GlyphSpec {
  /** The character. Identical in the UI, the CLI and rendered Markdown. */
  readonly glyph: string;
  /** Design token name. Never a literal colour — see no-raw-color.cjs. */
  readonly token: "--steel" | "--brass";
  readonly label: string;
  readonly meaning: string;
}

export const NODE_GLYPHS: Readonly<Record<NodeKind, GlyphSpec>> = {
  deterministic: {
    glyph: "\u25A0", // ■
    token: "--steel",
    label: "Deterministic",
    meaning: "Application code. No model, no spend, no ambiguity.",
  },
  model: {
    glyph: "\u25C6", // ◆
    token: "--brass",
    label: "Model",
    meaning: "One model call or a bounded tool loop. The only place tokens are spent.",
  },
  gate: {
    glyph: "\u25C7", // ◇
    token: "--steel",
    label: "Gate",
    meaning: "Deterministic branch. Decides whether more models are worth paying for.",
  },
  loop: {
    glyph: "\u21BB", // ↻
    token: "--steel",
    label: "Loop",
    meaning: "Bounded iteration with an explicit maximum. Never open-ended.",
  },
  human: {
    glyph: "\u25EB", // ◫
    token: "--steel",
    label: "Human",
    meaning: "Checkpoint requiring an operator decision.",
  },
  subgraph: {
    glyph: "\u25A3", // ▣
    token: "--steel",
    label: "Subgraph",
    meaning: "Composed, typed sub-workflow. Verification is one of these.",
  },
};

/**
 * State vocabulary. Rendered as a stripe in the state's token colour plus a
 * mono label — never hue alone, so it survives a monochrome terminal and
 * colour-vision deficiency.
 *
 * `unexamined` and `degraded` deliberately share --faint: the absence of
 * colour is itself the claim the product is making (spec §32.1).
 */
export const RUN_STATES = [
  "verified",
  "dissent",
  "refuted",
  "tainted",
  "unexamined",
  "degraded",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const STATE_TOKENS: Readonly<Record<RunState, string>> = {
  verified: "--verified",
  dissent: "--brass",
  refuted: "--refuted",
  tainted: "--tainted",
  unexamined: "--faint",
  degraded: "--faint",
};

export const STATE_LABELS: Readonly<Record<RunState, string>> = {
  verified: "verified deterministically",
  dissent: "dissent preserved",
  refuted: "refuted by counter-evidence",
  tainted: "tainted — untrusted origin",
  unexamined: "unexamined — no coverage",
  degraded: "degraded independence",
};

/** ASCII fallback for terminals that cannot render the box-drawing set. */
export const ASCII_FALLBACK: Readonly<Record<NodeKind, string>> = {
  deterministic: "[#]",
  model: "<*>",
  gate: "< >",
  loop: "(@)",
  human: "[|]",
  subgraph: "[+]",
};
