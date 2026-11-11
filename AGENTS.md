# Agent instructions

arbitra is a local code-audit tool. It has AI models from different vendors audit a project side by side, checks each
issue against the source before it plans a fix, and hands the plan back as prompts a coding agent can carry out. It
runs on the user's own computer, binds only to loopback, and never changes the audited code.

Start with `WORK-REMAINING.md`: open work only, each item with its next step and its place in the order. `README.md`
covers install and use. `docs/development.md` says how to pick the work up; `docs/architecture.md`, `docs/privacy.md`
and `docs/security.md` hold the decisions in force.

## Governing principle

Set by the owner in the handbook (GitHub: `ServesYouRice/handbook`; read its `README.md`, `standards.md` and
`projects/arbitra.md`):

- Build arbitra as a full-featured product with best practices and the right technology, not as a demo. Do not choose
  the cheap option now and defer the proper one "until needed".
- Do not overkill either. It is a single-user local tool. What `docs/architecture.md` lists under "Explicitly out of
  scope" stays out: hosting as a service, accounts, teams, billing, cloud queues and telemetry.
- Free tiers first. A paid service is taken only once a limit is actually hit.

## Working rules

- Inspect the relevant code before making claims or edits. Match its naming, style and comments.
- Do not weaken, skip or quarantine a test to make it pass.
- Verification is local; there is no hosted CI. `.claude/hooks/check.sh` runs `pnpm run ci`, the build and the browser
  tests (see `CLAUDE.md`). Hosted CI is allowed only to build and test on platforms the dev PC cannot run.
- Do not name the owner's private projects in anything a reader of this repository sees. Describe them instead ("a web
  app", "a comments service"). Older mentions in the docs, the measured-runs table and the tests are being replaced;
  do not add new ones.
- Ask before destructive, hard-to-reverse or externally visible actions: a release, a tag, a push to `main`.
