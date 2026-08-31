---
name: planny
description: >-
  Track a project's tasks and operator decisions with the planny CLI instead
  of a plan.md. Use whenever the user asks to add, update, finish, cancel or
  reprioritize a task; asks what to do next or to work on a task or project;
  asks for the plan, progress, or dependencies; wants to go through open
  decisions; or whenever you hit a question only the operator can answer —
  record that as a decision task, don't just ask in chat. Requires a .planny
  store in the project (`planny init` creates one).
---

# planny

planny keeps the plan out of your context window. Each task is one markdown
file with YAML frontmatter under `.planny/tasks/<id>.md`. Ids (`t1`, `t2`, …)
are stable for the life of the project; file paths never change when parents
or priorities change. Load only what you need with getter commands instead of
reading a whole plan.md.

Rules that keep the store consistent:

- **Mutate through the CLI, never by editing task files by hand.** The CLI
  keeps relationships one-sided (children and "blocks" are derived), rejects
  cycles, and keeps priority consistent with dependencies. Reading the raw
  files (grep, cat) is fine and encouraged.
- Write task names and bodies in Simplified Technical English in spirit:
  short sentences, active voice, one meaning per word, no project shorthand
  without a definition.
- A task that needs several owners (plan, build, review) becomes child tasks,
  each with one owner.

## The action map

What the user says → what you run. Accept bare numbers as ids (`3` = `t3`).

| The user says | Run |
| --- | --- |
| "add a task …", "we should also …" | `planny add "<name>" -d "<detail>" [--parent] [--blocked-by] [--kind] [--model]` |
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

You have a question only the operator can answer → **add a decision task**
(next section). Do not park the question in chat or a TODO comment.

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
Getters: `show <id>`, `list` (`--status --kind --type --model --parent
--recursive --blocked`), `next`, `decisions`, `progress`, `path <id>`,
`tree`, `deps` — all machine-readable with `--json` where it matters.
