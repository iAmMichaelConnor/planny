# planny

A CLI task and decision tracker for AI-driven projects. Tasks live as markdown
files with YAML frontmatter under `.planny/tasks/`, one file per task, named by
stable id (`t12.md`). Hierarchy and dependencies are fields, never directory
structure, so a re-parent never moves a file.

## Layout

- `src/` — TypeScript source. One module per concern:
  - `types.ts` — the Task shape, statuses, constants.
  - `frontmatter.ts` — markdown + YAML frontmatter parse/serialize.
  - `store.ts` — repo discovery (walks up for `.planny`; a linked git
    worktree defers to the main worktree's store unless `.planny/fork`
    exists), read/write tasks, id allocation.
  - `lock.ts` — the advisory cross-process lock every mutation runs in.
  - `graph.ts` — derived relationships: children, blocking, ancestors, descendants, cycle checks.
  - `priority.ts` — rank ordering, bump, the dependency-order invariant and its repair.
  - `ops.ts` — every mutation (add, update, status, cancel, resolve, bump). CLI and server both call this; never mutate a task file anywhere else (one exception: doctor repairs).
  - `doctor.ts` — integrity checks for hand-edited stores, plus safe repairs. It writes files directly because ops assumes the invariants doctor restores; it is the only writer besides ops.
  - `query.ts` — reads: filters, next-task selection, progress.
  - `catchup.ts` — per-consumer cursors and the changed-since delta.
  - `render.ts` — markdown export, terminal tree, dependency forest.
  - `cli.ts` — commander wiring only; no logic.
  - `bin.ts` — the executable entry point; calls cli.
  - `discover.ts` — find every `.planny` store under given roots, for
    `planny serve --all`. Skips hidden and build directories, and a linked
    worktree's checkout of a tracked plan, the same rule `store.findRoot`
    follows.
  - `server.ts` — localhost API + static UI serving; calls ops/query only.
    Also the detached start, probe and stop of a board, which `serve-all.ts`
    loops over.
  - `serve-all.ts` — `planny serve --all`: start a board for every plan found and
    serve the page that links to them, one process on its own port (5890).
    Its log is `planny-boards.log` in the OS temp dir.
- `web/` — static localhost UI (no build step, no framework).
- `test/` — vitest suites, one per module, plus CLI end-to-end, a
  real-process detach suite, and a jsdom UI walk.
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
- Resolving a decision creates an outcome task as the decision's child,
  rewires the decision's active dependants to wait on it, and appends
  `Outcome task: <id>` to the decision body — all in the same locked
  mutation. `--reject` records the rejection and creates nothing.
- Ids are never reused.
- The ops-only rule covers *task files*. Five store-level files are owned
  elsewhere by design: `.planny/cursors.json` (written by catchup, under the
  same lock), `.planny/lock` (the lock module itself),
  `.planny/serve.json` (written by the server while it listens; `planny url`
  probes before trusting it, so a crash leaving it behind is harmless),
  `.planny/serve-port` (the port this store last served on, written on every
  bind and never deleted, so the board keeps one address across restarts),
  `.planny/serve.log` (the detached server's output; `serve --clean-logs`
  deletes it once the server is gone and the file is old), and
  `.planny/last-seen.json` (the rewind tripwire, advanced by every
  `store.save`; opens and scans warn while the store is behind it, and
  deleting it acknowledges a deliberate rewind).
- Ops validates input shapes at runtime (enums, id lists, bump targets) —
  the server passes JSON bodies through, so the funnel must not trust its
  compile-time types.

## Commands

`npm run build` compiles to `dist/`. `npm test` runs vitest once.
`node dist/bin.js` is the CLI (`planny` when linked).

## Dogfooding

This repo tracks its own remaining work in its own `.planny` store. Follow
the planny skill (`skills/planny/SKILL.md`, symlinked into
`.claude/skills/`): use the CLI for every task and decision change, and
record open questions as decision tasks, not chat asides. Rebuild before
using the CLI after source changes.

### Testing philosophy

**Red-green-refactor is the law.** Every feature and bug fix follows this cycle strictly:

1. **Red** — Write a failing test first. Run it. Watch it fail. If it doesn't fail, your test is wrong. The failure message must clearly describe what's broken — if you can't tell what went wrong from the output, rewrite the assertion.
2. **Green** — Write the minimum code to make the test pass. Not the "right" code. Not the "clean" code. The *least* code that turns red to green. Resist the urge to generalize.
3. **Refactor** — Now clean up. Extract helpers, rename, restructure — but only while tests stay green. If a refactor breaks a test, you went too far. Back up.
4. **Harden** — Ask: "what would break this?" Add that case. Repeat until you can't think of anything. Edge cases, error paths, boundary values, concurrent access.

## Writing style

All prose in this repo follows Simplified Technical English in spirit:
short sentences, active voice, one meaning per word, plain words, no
project shorthand without a definition. That covers task and decision
bodies, this file, the README, the skill and its references, and the
CLI's help text. Decision bodies use the section layout given in
`skills/planny/references/decision-format.md`.
