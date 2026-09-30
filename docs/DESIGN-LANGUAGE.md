# arbitra — design language

> Visual references:
> [Mark studies 01–05](https://claude.ai/code/artifact/27be5a4a-1bed-4d87-a626-265ab44fd794) — thirty-seven candidates, and why this one won.

This document is normative for `apps/web`, the CLI's human-readable output, and the
Markdown rendered into `implementation/`. It was derived from the original build
specification, which is not in this repository; the § references point to it.

Machine-readable companions live beside it in `docs/brand/`:

| File | Destination | Purpose |
|---|---|---|
| `tokens.css` | `apps/web/src/tokens.css` | Colour, type scale, space scale, density |
| `glyphs.ts` | `packages/schemas/src/glyphs.ts` | Node + state glyphs, one source of truth |
| `no-raw-color.cjs` | `tooling/eslint-rules/` | Fails `pnpm lint` on a colour literal in web scripts |

Each file is shipped at its destination, byte for byte. `pnpm run design:check`
(`examples/design-check.test.ts`) fails if the shipped glyph table differs from this copy,
or if the shipped tokens add or drop a token name.

Nothing here is a mood choice. Every rule below traces to a property of the product.

| What the product is | What the design must therefore be |
|---|---|
| Preserved dissent is the deliverable, not a failure state (§18.8) | Disagreement gets its own colour, and that colour is the brand |
| The node taxonomy is closed — six kinds (§8) | Those six glyphs are the icon set; a seventh icon is a defect |
| All three modes are read-only (§2.1) | The interface reports, it never persuades |
| Fabricating an unmeasured metric is a hard failure (§32.1) | `null`, `degraded` and `unexamined` are designed states, never blank cells |
| Every model boundary is a trust boundary (§4.2) | Provenance is surface-level, not a detail view |
| The spec's native form is monospace box-drawing (§33) | Mono is the *display* face, not the code face |

## The five rules

- **R1 — Evidentiary, not persuasive.** Every screen is a record of what happened. If a
  pixel makes a result feel more certain than it is, remove it.
- **R2 — Colour is semantic.** Six hues, one meaning each. Decorative use of a hue steals
  from the meaning it carries elsewhere. Enforced by `no-raw-color.cjs`.
- **R3 — The taxonomy is the icon set.** Six node glyphs, six state marks, nothing else.
  New concepts get a label, not a new symbol.
- **R4 — Structure over ornament.** Hairline rules, square corners. No shadows, no
  gradients, no rounded cards.
- **R5 — Show the disagreement.** Where models diverged, say so before saying what was
  concluded. Consensus without visible dissent is a lie of omission.

## Colour

Full token definitions are in `docs/brand/tokens.css`. Dark is the primary theme. Both
themes are complete; **no colour may be defined only inside a media query or a
`[data-theme]` block.**

| Token | Light | Dark | Meaning | Never used for |
|---|---|---|---|---|
| `--brass` | `#96682A` | `#C0873C` | Dissent preserved; model attention. **The brand accent.** | Buttons, links, headings, generic emphasis |
| `--steel` | `#54697D` | `#7D93A8` | Deterministic work the orchestrator owns | Model activity |
| `--verified` | `#2C7A61` | `#3E9C7A` | Claim upheld by evidence, not by vote | Generic success |
| `--refuted` | `#A5443B` | `#C1554A` | Claim mechanically disproved; blocking failure | Severity |
| `--tainted` | `#6A57A4` | `#8E7BC4` | Untrusted provenance | Any severity level |
| `--faint` | `#98A2AC` | `#5C666F` | Null result, unexamined surface, degraded confidence | De-emphasising real data |

Neutrals carry a blue-slate bias. Pure grey is not in the palette.

**Severity is stripe width, not hue** — 2px low through 5px critical. It has to survive a
monochrome terminal and colour-vision deficiency, and it keeps red free to mean *refuted*.

## Typography

- **Display** — IBM Plex Mono 600, tracking `-0.03em`. Headings, wordmark, labels, all numbers.
- **Body** — IBM Plex Sans 400, 16px / 1.62, max 66ch. Prose only.
- **Data** — IBM Plex Mono 400, `font-variant-numeric: tabular-nums`, tracking `+0.03em`.

Setting headings in mono is deliberate: a tool whose output is a rendered directory of
Markdown should not set its headings in a marketing grotesque.

### Scales

Six type sizes, seven space steps. **A seventh type size is a defect** — when something
needs to stand out and the scale is exhausted, change weight or colour, not size. A spacing
value off the scale is the most common way a clean layout turns to mush.

```text
type   11 label · 13 micro · 16 body · 19 lead · 23 head · 38 display
space   4 · 8 · 12 · 20 · 32 · 52 · 84          (--s1 … --s7)
```

### Density

| | |
|---|---|
| Dense row (Issue Board, task lists) | 34px |
| Default row | 44px |
| Border weight | 1px — the only weight in the system |
| Corner radius | 0 |
| Shadows | none |
| State stripe | 2–5px by severity |
| Text measure | 66ch |

### Pages, not columns

The first interface was the four-column shell of §26: Model Pool, workflow graph,
prompt/context/contract, and inspector with run controls. It set a run's record beside a
draft of the next run's configuration and never said which panel described which, so R1
failed at the level of the layout. Since 2026-09-29 the interface is four places, each with
one job, and each addressable:

| Place | Address | Holds |
|---|---|---|
| Runs | `/` | Every recorded run: its state, what ran it, its gate, the repository it read |
| Run | `?run=<id>&view=<tab>&item=<kind>:<id>` | One run: header, the decisions it waits on, the tabs its mode has, one details panel |
| New run | `?page=new-run&from=<start>` | One configuration: filled in, checked by the orchestrator's preflight, saved, started |
| Workflows | `?page=workflows` | The workflow graph editor |

A run page reads top to bottom:

- **Header.** Mode and workflow as the page title, the state chip, and the one lifecycle
  action the state allows (cancel, or resume). Beneath it the run ID, repository, times,
  what executed it (models, or scripted detectors that make no model call) and the gate.
- **Decision banner.** Present only while the run is blocked, above every tab, with the
  decisions themselves and the resume that follows them.
- **Tabs.** Only those the mode can fill. Audit: Overview · Issues · Plan · Activity ·
  Evaluation. Feature: Overview · Requirements · Plan · Activity · Evaluation. Testing:
  Overview · Plan · Execution · Activity · Evaluation.
- **Details panel.** Whatever is selected (a node, an issue, a plan step, a model attempt,
  an artifact), shown from the run's own records. It sits beside the tab, 360–440px, behind
  a 1px hairline, and exists only while something is selected. Below 1180px it is a modal
  drawer from the right; below 900px the page is a single column.

Panel padding is `--s4`; page content stops at 1480px. Sections are separated by a hairline,
never a gap alone and never a shadow.

### Emphasis without hue

R2 leaves no hue for "look here", so emphasis is weight, fill and the neutral ink:

- **The primary action** of a place (approve, resume, save and start) is filled with
  `--ink` and lettered in `--surface`. There is one per place. Every other action is a
  hairline button.
- **Links** are underlined `--ink`. **The current page and tab** carry an `--ink` rule.
  Brass is never navigation.
- **Waiting on the operator** (a blocked run, a pending approval) is an `--ink` stripe and
  the human-checkpoint glyph ◫. It is not a seventh state: it says whose move it is.
- **Every state is words and code.** A chip reads `waiting for your decision BLOCKED`; a gate
  reason reads `coverage is incomplete degraded_coverage`. The words are a reading aid; the
  code is the record.
- **Prose is sans; data is mono.** Model-authored text and explanations use the body face;
  identifiers, counts and paths use the data face. Hashes are cut to eight characters on
  screen, with the full value one hover away.

## Glyphs

Taken verbatim from the spec's closed taxonomy (§8) and shipped as **one typed module**
(`docs/brand/glyphs.ts`, shipped as `packages/schemas/src/glyphs.ts`) that the Markdown
renderer and the graph view import — two copies of the glyph table is the same class of
defect as two orchestrators.

```text
■  DETERMINISTIC   application code; no model            --steel
◆  MODEL           one model call or bounded tool loop   --brass
◇  GATE            deterministic branch or routing       --steel
↻  LOOP            bounded iteration, explicit maximum   --steel
◫  HUMAN           operator checkpoint                   --steel
▣  SUBGRAPH        composed, typed sub-workflow          --steel
```

State vocabulary: `verified` · `dissent` · `refuted` · `tainted` · `unexamined` ·
`degraded`. Rendered as a stripe in the state's token colour plus a mono label. Never as a
hue-only cue. ASCII fallbacks for limited terminals are in `glyphs.ts`.

## Logo — Triangle of Error

**Locked.** Selected from thirty-seven candidates across five mark studies.

When a surveyor takes bearings on the same point from three stations, the sight lines
almost never meet. They leave a small triangle, and the rule that goes with it is four
hundred years old: **the true position lies inside the disagreement**, not at any one
observer's reading. That is arbitra's thesis, already named by a discipline that solved it
first.

Three sight lines, three stations, and the error triangle in brass — the only element of
the mark that is not a measurement.

### Construction

On a 32-unit grid, every vertex a whole number. Each line contains exactly one edge of the
triangle, so the figure is geometrically true rather than suggestive.

```text
error triangle   P1 (12,11)   P2 (21,14)   P3 (16,19)

line 1   (3,8)  -> (30,17)    slope  1/3    contains edge P1-P2
line 2   (26,9) -> (10,25)    slope -1      contains edge P2-P3
line 3   (10,7) -> (19,25)    slope  2      contains edge P3-P1

stations   3.2 squares, centred on one endpoint of each line
strokes    2.0 primary, 3.0 reduction
```

The mark can be rebuilt from that table alone. If a redraw does not put all three lines
through the triangle's corners, it is wrong.

### The files, and when to use which

| File | Use |
|---|---|
| `mark-triangle-of-error.svg` | Primary. Above 32px: lockups, README, docs, slides, CLI splash |
| `mark-triangle-of-error-mono.svg` | One colour, inherits `currentColor`. Print, etch, embroidery, reversed |
| `mark-triangle-reduction.svg` | 17–32px. Heavier strokes, stations dropped — a separate drawing, not a scaled copy |
| `mark-triangle-icon.svg` | 16px and below, and any square context: favicon, app icon, avatars, editor tree |
| `mark-triangle-icon-mono.svg` | One-colour icon |

The icon is the error triangle alone, scaled 2.6× about its centroid. This is the whole
identity compressed to one shape: at small sizes the lines are noise and the disagreement
is the signal, which is also the argument the product makes.

### Known limits, accepted

- The full mark needs 32px. Below that the three strokes merge; use the reduction to 17px
  and the icon below.
- Native ratio is roughly 5:4. It does not centre well in a square — hence the icon.
- Rotating or mirroring it changes which station is wrong. Never do either.

### Wordmark rules

- **Always lowercase**, in every context — spec, CLI, package name, prose.
- IBM Plex Mono 500, tracking `-0.045em`, so the mono rhythm tightens into a word rather
  than reading as a filename.
- Horizontal lockup separates mark and word with the same 1px `--line` rule used elsewhere;
  mark height matches the wordmark cap height.
- Clear space: one station-square width (3.2 units at mark scale) on all sides.

## Enforcement

R2 is only real if it is mechanical, which is how this project treats every other
invariant. `no-raw-color.cjs`, installed as `tooling/eslint-rules/no-raw-color.cjs`, fails
`pnpm lint` on a colour literal in `apps/web/src` scripts, alongside the existing
determinism lint (TASK-004). `pnpm run design:check` fails on a hex colour in any stylesheet
other than `tokens.css`. Both run in `pnpm run ci`.

The web suite reads its own sources for the rest (`apps/web/test/design.test.ts`): every
stylesheet uses token colours, square corners, no shadow and no gradient, and draws borders
only as hairlines or state stripes; brass appears only on dissent and on a model's proposal
awaiting the operator; a stylesheet that draws a border also styles forced-colours mode; the
details panel becomes a drawer below 1180px; and the six glyphs come only from the shared
table. The browser suite (`pnpm --filter @arbitra/web e2e`) checks at 1100px and 800px that
no control is covered by another element, as one was in the four-column shell at those widths.
