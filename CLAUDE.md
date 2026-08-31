# planny-wanny

A CLI task and decision tracker for AI-driven projects. Tasks live as markdown
files with YAML frontmatter under `.planny/tasks/`, one file per task, named by
stable id (`t12.md`). Hierarchy and dependencies are fields, never directory
structure, so a re-parent never moves a file.

## Layout

- `src/` — TypeScript source. One module per concern:
  - `types.ts` — the Task shape, statuses, constants.
  - `frontmatter.ts` — markdown + YAML frontmatter parse/serialize.
  - `store.ts` — repo discovery (walks up for `.planny`), read/write tasks, id allocation.
  - `graph.ts` — derived relationships: children, blocking, ancestors, descendants, cycle checks.
  - `priority.ts` — rank ordering, bump, the dependency-order invariant and its repair.
  - `ops.ts` — every mutation (add, update, status, cancel, resolve, bump). CLI and server both call this; never mutate a task file anywhere else.
  - `query.ts` — reads: filters, next-task selection, progress.
  - `render.ts` — markdown export, terminal tree, dependency forest.
  - `cli.ts` — commander wiring only; no logic.
  - `server.ts` — localhost API + static UI serving; calls ops/query only.
- `web/` — static localhost UI (no build step, no framework).
- `test/` — vitest suites, one per module plus CLI end-to-end.
- `skills/planny/SKILL.md` — the skill that teaches an AI to use the tool
  (symlinked into `.claude/skills/` so sessions in this repo load it).
- `PROMPT.md` — the founding prompt, verbatim.

## Invariants (enforce in ops, cover in tests)

- One canonical side per relationship: `parent` is stored, children are derived;
  `blocked_by` is stored, blocking is derived. CLI/API accept both directions as
  input but always write the canonical side.
- Parent links and `blocked_by` links must each stay acyclic.
- A blocked task must never rank above (higher priority than) an active blocker.
  Every mutation repairs violations by demoting the blocked task to the nearest
  legal rank.
- Cancelling a task with `--replaced-by` rewires dependants' `blocked_by` onto
  the replacement tasks.
- Ids are never reused.

## Commands

`npm run build` compiles to `dist/`. `npm test` runs vitest once.
`node dist/cli.js` is the CLI (`planny` when linked).

### Testing philosophy

**Red-green-refactor is the law.** Every feature and bug fix follows this cycle strictly:

1. **Red** — Write a failing test first. Run it. Watch it fail. If it doesn't fail, your test is wrong. The failure message must clearly describe what's broken — if you can't tell what went wrong from the output, rewrite the assertion.
2. **Green** — Write the minimum code to make the test pass. Not the "right" code. Not the "clean" code. The *least* code that turns red to green. Resist the urge to generalize.
3. **Refactor** — Now clean up. Extract helpers, rename, restructure — but only while tests stay green. If a refactor breaks a test, you went too far. Back up.
4. **Harden** — Ask: "what would break this?" Add that case. Repeat until you can't think of anything. Edge cases, error paths, boundary values, concurrent access.

## Writing style

Task and decision bodies follow Simplified Technical English in spirit: short
sentences, active voice, one meaning per word, plain words, no project
shorthand without a definition. Decision bodies use the section layout given in
`skills/planny/SKILL.md`.
