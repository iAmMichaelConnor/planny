---
name: planny
description: >-
  Track a project's — or an AI session's — tasks and operator decisions
  with the planny CLI instead of a plan.md. Use whenever the user asks you
  to make a plan or break work down (the plan must be built as planny
  tasks); asks to add, update, finish, cancel or reprioritize a task; asks
  what to do next or to work on a task or project; asks for the plan,
  progress, or dependencies; wants to go through open decisions; when you
  think of a task yourself, record it too; or whenever you hit a question
  only the operator can answer — record that as a decision task, don't
  just ask in chat. Requires a .planny store in the project (`planny init`
  creates one).
license: MIT
---

# planny

planny keeps the plan out of your context window. Each task is one markdown
file with YAML frontmatter under `.planny/tasks/<id>.md`. Ids (`t1`, `t2`, …)
are stable for the life of the project; file paths never change when parents
or priorities change. Load only what you need with getter commands instead of
reading a whole plan.md. If the `planny` command is missing, install it
first: `npm install -g planny` (Node 20+).

Rules that keep the store consistent:

- **Mutate through the CLI, never by editing task files by hand.** The CLI
  keeps relationships one-sided (children and "blocks" are derived), rejects
  cycles, and keeps priority consistent with dependencies. Reading the raw
  files (grep, cat) is fine and encouraged.
- Write task names and bodies in Simplified Technical English (STE) in
  spirit:
  short sentences, active voice, one meaning per word, no project shorthand
  without a definition.
- A task that needs several owners (plan, build, review) becomes child tasks,
  each with one owner.
- **planny is the plan of record.** Manage every task, decision, and the
  plan's progress through the CLI — never a parallel plan.md, a harness
  todo list, or private notes. When the user asks you to make a plan, the
  plan IS the planny store: you must build it as planny tasks (see
  "Creating tasks and plans").
- **Every feature request, bug report, or change of plan becomes a task
  first** — `planny add` it the moment the user asks, in any phrasing,
  including a mid-conversation aside — and the moment you think of one
  yourself. Then work it: `start` when you begin, `done` when it ships. A
  request or idea tracked only in chat, a TODO comment, or your own head
  is one that gets lost.
- **Serve the board at session start.** When you begin working in a project
  that has a `.planny` store, check whether the UI is already up
  (`planny url` prints the address, and exits 1 when it is not); if not,
  run `planny serve --detach` and tell the operator the URL it prints.
  The detached server runs in its own OS session, so it outlives you.
  Do not use your harness's background-task feature instead: harnesses
  stop those at session end, on /clear, and on context compaction, and
  the operator's board dies with them. `planny serve --stop` ends the
  detached server when asked.
  The server binds 127.0.0.1 only, so when the operator works on
  this machine remotely, also give them the forward to run from their own
  machine, ports matching the served port:
  `ssh -L 5891:127.0.0.1:5891 <host>`, then open http://localhost:5891.
- **Identify yourself.** Run `export PLANNY_SESSION=<your session id>` once
  at the start of a session (or pass `--session <id>` before any
  subcommand). If your harness runs each command in a fresh shell, the
  export does not survive between commands. The form that works in every
  shell and every harness is the environment prefix, written out on each
  command: `PLANNY_SESSION=<id> planny …`. Type it in full each time; do
  not build command fragments in shell variables — expansion rules differ
  between shells, and the flag can arrive as one broken token.
  Creates then stamp `created_by`, and the task's history logs
  every status change, priority move, re-parent, dependency edit and rename
  with `{at, …, by}`, so the operator can see which agent did what.
  Starting a task claims it: `planny start` on a task another session
  started refuses until you pass `--take`, which records the takeover.

## The action map

What the user says → what you run. Accept bare numbers as ids (`3` = `t3`).

| The user says | Run |
| --- | --- |
| "add a task …", "we should also …", any feature request or bug report | `planny add "<name>" -d "<detail>" [--parent] [--blocked-by] [--kind] [--model]` — record it before building it |
| "break X into pieces" | `planny add "<piece>" --parent <X>` per piece |
| "X is done" / "start X" / "reopen X" | `planny done <X>` / `planny start <X>` / `planny todo <X>` |
| "drop X" / "X is replaced by Y" | `planny cancel <X> [--replaced-by <Y>]` |
| "do X first", "deprioritize X" | `planny bump <X> top` / `bottom` / `<position>` |
| "X can't happen until Y" | `planny update <X> --add-blocked-by <Y>` |
| "change X …" (any field) | `planny update <X> --name/--desc/--kind/--model/--parent/--priority …` |
| "what's next?" | `planny next [n] [--kind ai] [--json]` |
| "let's work on X" | `planny next --under <X> --json`, then work the tasks (below) |
| "show the plan" | `planny tree` (hierarchy) / `planny deps` (order) / `planny list --json` |
| "how far along are we?" | `planny progress [--parent <X>]` |
| "write the plan to a file" | `planny export --out plan.md [--status todo,in-progress]` |
| "let's go through the decisions" | see "Working the decision queue" |
| "open the board" | `planny serve` (localhost UI; leave it to the operator) |
| "is the store broken?", a command errors on a task file | `planny doctor` (add `--fix` to apply the safe repairs) |

You have a question only the operator can answer → **add a decision task**
(see "Decision tasks"). Asking in the terminal as well is fine — but the
task must exist regardless, because a question that lives only in chat
disappears when the operator is away, scrolls past, or answers later.
Never park a question in chat alone or in a TODO comment.

## Creating tasks and plans

When the user asks for a plan, or you break work down yourself, create one
task per piece of work with `planny add`. Fill each task in so a fresh
agent could pick it up with no other context:

- **Name**: short, imperative, specific — "Guard concurrent writes with a
  lock", never "locking stuff".
- **Description** (`-d`, or `--desc-file` for long bodies): self-contained
  STE prose. Say what the task is, why it exists, what done looks like,
  and give pointers — file paths, commands, the test to run. Include any
  constraint the name cannot carry. The reader must not need the
  conversation that produced the task.
- **Fields at creation, not later**: `--kind` (ai or operator), `--model`
  when particular model strengths suit the work, `--parent` to place it in
  the hierarchy, `--blocked-by` / `--blocks` for real orderings,
  `--priority` when it should not join at the bottom.
- **Structure**: work needing several owners or stages becomes child
  tasks, one owner each. Encode order as dependencies, never as prose
  ("do this after t7" in a description is invisible to `next`).
- **Decisions** use the section layout in
  [references/decision-format.md](references/decision-format.md).
- **Take ids from command output — never predict them.** Another writer
  (the operator's UI, a teammate agent) may take the next id at any
  moment; a hardcoded guess can claim someone else's task. When the new
  task is yours to work right now, `planny add "…" --start` creates,
  starts and claims it in one command, with no id to juggle.

Then sanity-check the plan you just built: `planny tree` (shape),
`planny deps` (order), `planny next` (is the first actionable task the
right one?).

An operator's quick-add often arrives rough — a two-word name, a pasted
thought. When you pick one up, bring it to this standard: rename it to a
short imperative name, and append what done looks like in STE. Keep the
operator's original words in the body; they are the ask of record.

## Working tasks

1. `planny next --json` (optionally `--under <id>` for one project). Each item
   carries the task, its ancestor path, and the tasks it unlocks. Tasks that
   share an ancestor belong together — give them to the same agent.
2. `planny start <id>` before you begin; `planny show <id> --json` for the
   full body, relationships and file path.
3. `planny done <id>` the moment it is finished — stale statuses are the
   problem this tool exists to solve. Heed warnings: finishing a task that is
   still blocked, or that has active children, usually means a missed update.
4. Requirements changed? `planny update` the task, or `planny cancel
   --replaced-by` and add the successor tasks. Never leave a task describing
   work nobody intends to do.

## Decision tasks

A decision is a task with `--type decision`: a question for the operator with
enough context to answer from the item alone. When you (the AI) hit a choice
that touches money, production, product trade-offs, an operational surface,
or a pure operator preference — or you are simply blocked on an answer —
create one:

```bash
planny add "Choose the database" --type decision --kind operator \
  --blocks t7 --desc-file decision.md   # or --desc / stdin via -
```

Write the body using the section layout in
[references/decision-format.md](references/decision-format.md) — read it
before writing your first decision. Blocked work gets `--blocked-by` pointing
at the decision, so the queue reflects what each answer unlocks.

**Uncertainty gates work.** When you are unsure an approach is right, when
you have flagged complexity, risk or downsides, or when the operator has
expressed concern or uncertainty about a piece of work — the go/no-go
becomes a decision task before any agent builds it. If a plain task
already covers the work, either convert it
(`planny update <id> --type decision --kind operator`, rewriting the body
into the decision layout with the analysis folded in) or add a decision
alongside that blocks it (`planny add "Decide …" --type decision
--kind operator --blocks <id>`). Convert when the whole task *is* the
question; add alongside when the task has agreed work plus one contested
aspect. Either way, an agent walking the queue then meets an operator
decision instead of silently attempting contested work.

### Working the decision queue

- `planny decisions [--json]` lists open decisions in answering order
  (unblocked first, then priority; a decision that blocks another sorts
  above it automatically).
- Present one decision to the user at a time: name, then the body verbatim.
- The user answers → `planny resolve <id> --response "<their words>"`
  (or `--accept` when they take your proposal, `--response-file` for long
  answers). **Interpret the response immediately**: apply it, and update or
  cancel the tasks it affects before moving to the next decision.
- The user skips → move on; the decision stays open.
- After the decided work ships, append the record the operator will look
  back on: `planny update <id> --append-desc "Built: … Files: … Tests: …
  How to test: … Runs at: …"`.
- `planny decide` is the operator's own interactive loop; don't run it
  yourself — you are the interpreter when you're in the loop.
### Staying current

Catch up at boundaries — when you start work, between tasks, and before
choosing what to do next. Never mid-task: information that arrives while
you are deep in something else only displaces working context.

- `planny catchup --json` is the default (it uses your `PLANNY_SESSION` as
  the consumer id; `--as <id>` overrides). It returns every task changed
  and every decision resolved since you last asked, then advances your
  stored cursor — you carry no state. `--peek` looks without advancing.
  Delivery is at-least-once: treat the delta as idempotent facts.
- Explicit windows, when a cursor is not what you mean:
  `planny decisions --resolved --since <time> --json` (answers, each with
  the tasks it unblocked) and `planny list --changed-since <time> --json`.
- One task's own timeline needs no store-wide diff: its typed `history`
  logs every status change, priority move, re-parent, dependency edit and
  rename with `{at, …, by}` — `planny show <id>` prints it, `--json`
  returns it.
- Skip your own footprints: entries whose `by` (in `history`/`created_by`)
  shares your session root are changes you already know about.
- There is no agent-facing watch mode, deliberately. File watching exists
  only as harness plumbing (the serve UI's live refresh); an agent that
  polls or subscribes mid-task is doing it wrong.
- While catching up, also run `planny next --kind operator` and tell the
  operator what is waiting on them — operator tasks move only when a
  human sees them.

## Priorities

Priority is one ordered list (position 1 = top). `bump` clamps to the nearest
legal position: a task never ranks above an active task that blocks it, and
the tool repairs the order automatically when edges change. Trust the order;
don't fight it by renumbering.

## Reference

Statuses: `todo`, `in-progress`, `done`, `cancelled` (cancelled tasks keep
their file; `--replaced-by` rewires dependants onto the successors).
Kinds: `ai`, `operator` by convention (free-form for new kinds); `--model`
records a preferred model, advisory only — reassign at load time if that
model is unavailable.
Updating: `npm update -g planny` refreshes the CLI and this skill together
— the skill ships inside the npm package, so a skills directory that
symlinks it follows automatically; a plugin install updates through its
marketplace instead.
Reading the plan — the exact query for each question:

- What is left to do? `planny list --status todo,in-progress --json`
  (add `--kind`, `--type`, `--model`, `--changed-since` to slice).
- What should be worked on now? `planny next [n] --json` — each item
  carries the task, its ancestor path, and the tasks it unlocks.
- How does task X relate to everything? `planny show X --json` — fields
  `ancestors` (parent chain, nearest first), `children`, `blockedBy`,
  `blocking`, and a `blocked` flag. The text form prints the same as
  path / children / waits on / blocks lines.
- Children of X? `planny list --parent X`; the whole subtree:
  add `--recursive`.
- What is blocked right now? `planny list --blocked` (and `--unblocked`
  for the opposite).
- The shape at a glance: `planny tree` (hierarchy), `planny deps`
  (blockers above what they block), `planny progress [--parent X]`
  (completion).
- The file behind a task: `planny path X`.
`planny doctor [--fix] [--json]` checks a store that may have been edited by
hand (dangling ids, cycles, duplicate ranks, stale statuses) and repairs the
problems that have one right answer; it exits 1 while errors remain.

This file covers the common paths, not every flag. The full reference is
`planny <command> --help`: every command documents its options and carries
examples, and it cannot drift from the binary.

A bug in planny itself goes upstream: add a task to your own plan to open
the issue or PR at <https://github.com/iAmMichaelConnor/planny>.
