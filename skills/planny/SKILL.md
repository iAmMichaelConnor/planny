---
name: planny
description: >-
  Track a project's — or a multi-agent AI session's — tasks and outstanding human decisions
  with the planny CLI instead of a PLAN.md. Use whenever the user: asks you
  to make a plan or break work down; asks to add, update, finish, cancel
  or reprioritize a task; asks what to do next; tells you to work on a task or
  project; asks for the plan, progress, or dependencies; asks for what has changed; wants to go through open decisions; when you
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

- **You must always mutate through the CLI (or a human can use the UI); never by writing or editing
  task files under `.planny/` directly**, because direct edits would
  catastrophically skip the CLI's id assignment, relationship bookkeeping
  (parent/child, blockers), history, and data validation checks.
  _Reading_ the raw files (grep, cat, etc) is fine and encouraged.
- **Run every command from inside the project dir whose plan you mean
  to change.** The CLI acts on the `.planny/` store that relates to
  your current directory (a subdirectory is fine — the CLI walks up
  until it reaches a `.planny/` dir; when in doubt, check `pwd` before
  calling the CLI).
- Write task names and bodies in Simplified Technical English (STE) in
  spirit: short sentences, active voice, one meaning per word, no project
  shorthand without a definition.
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
- An idea you doubt becomes a decision task, not a plain task — see
  "New ideas, which carry doubts, become a decision task first".
- **A checklist in a document is a task list.** If you are
  tracking your own list of work and marking completion against it —
  checkboxes, tick marks, `Status:` fields, an open/closed split — you
  should be using planny instead: stop and run `planny add` for each
  item, whatever the section is called (queue, register, backlog,
  follow-ups, review debt, next steps) — including a section you are
  about to write. Convert any such list you find into planny tasks the
  same way. The document keeps the analysis and cites the task ids.
- **Serve the board at session start.** Run `planny serve --detach` and
  tell the operator the URL it prints. Never pass `--port`: the command
  takes the port this store used last, or the first free one, so two
  stores on one machine never collide. `planny url` re-prints the
  address at any time. The detached server outlives your session; a
  harness background task dies at session end, /clear, or compaction,
  and the operator's board with it — never use one for the board.
  `planny serve --stop` ends it. An operator who works in several plans
  can run `planny serve --all --detach` once: it starts a board for every
  plan on the machine and prints one page that links to them all.
- **Identify yourself.** Prefix every planny command:
  `PLANNY_SESSION=<your session id> PLANNY_PROJECT=<store dir name> planny …` — the
  one form that survives every shell and harness (an `export` dies in a
  fresh-shell harness; shell variables can mangle the flag). The session
  id (PLANNY_SESSION) attributes your task creation and every history entry (`{at, …, by}`), so
  the operator can see which agent did what. PLANNY_PROJECT makes the
  CLI refuse commands aimed at a different store, so a wrong `cd` cannot
  touch the wrong plan.
- **In a linked git worktree, planny uses the main worktree's plan** —
  the worktree's own `.planny` checkout is ignored unless a
  `.planny/fork` marker makes the split deliberate.
- The server binds 127.0.0.1 only, so a remote operator needs a forward
  from their own machine. Run `planny serve --forward` here (or
  `--all --forward` for every board) and give them the line it prints, to
  paste on their own machine. It prints `<host>` for the operator to fill
  in, with this machine's name and addresses as candidates. Offer those and
  ask which one they ssh to, then hand back the line with `<host>` replaced
  — never pick one yourself, because only they know what reaches this
  machine from where they sit. Never give them
  `ssh $(planny serve --forward) <host>` — the substitution would run on
  their machine, which has no plan on it.
- **Starting a task claims it.** `planny start` on another session's
  task refuses unless you pass `--take`, which records the takeover,
  but you should _rarely_ need `--take`.

## The action map

What the user says → what you run. Accept bare numbers as ids (`3` = `t3`).

| The user says | Run |
| --- | --- |
| "add a task …", "we should also …", any feature request or bug report | `planny add "<name>" -d "<detail>" [--parent] [--blocked-by] [--kind] [--model]` — record it before building it |
| "break X into pieces" | `planny add "<piece>" --parent <X>` per piece |
| "X is done" / "start X" / "reopen X" | `planny done <X>` / `planny start <X>` / `planny todo <X>` |
| "drop X" / "X is replaced by Y" | `planny cancel <X> [--replaced-by <Y>]` |
| "park X", "not now", "X waits for Y to happen" | `planny park <X> --until "<what brings it back>"` — it leaves the queue, keeps its place |
| "do X first", "deprioritize X" | `planny bump <X> top` / `bottom` / `<position>` |
| "X can't happen until Y" | `planny update <X> --add-blocked-by <Y>` |
| "change X …" (any field) | `planny update <X> --name/--desc/--kind/--model/--parent/--priority …` |
| "what's next?" | `planny next [n] [--kind ai] [--json]` |
| "let's work on X" | `planny next --under <X> --json`, then work the tasks (below) |
| "show the plan" | `planny tree` (hierarchy) / `planny deps` (order) / `planny list --json` |
| "how far along are we?" | `planny progress [--parent <X>]` |
| "write the plan to a file" | `planny export --out plan.md [--status todo,in-progress]` |
| "let's go through the decisions" | see "Working the decision queue" |
| "open the board" | `planny serve --detach` (see "Serve the board at session start") |
| "open all my boards", "where are my boards?" | `planny serve --all --detach` — one page that links every plan's board |
| "is the store broken?", a command errors on a task file, a git merge or checkout touched `.planny` | `planny doctor` (add `--fix` to apply the safe repairs) |

If you have a question only the operator can answer → instead, **add a decision task**
(see "Decision tasks"). Asking in the terminal as well is fine — but the
task must exist regardless, because a question that lives only in chat
disappears when the operator is away, scrolls past, or answers later.
Never park a question in chat alone or in a TODO comment.

If you are about to draft a PLAN.md, DECISIONS.md, next-steps, follow-ups, or TODO section in a
document → instead, `planny add` each item, then cite the task ids in the
document. The analysis stays in the document; the statuses live in
planny.

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
- **A body that quotes a command needs `--desc-file`.** Inside a
  double-quoted `-d "…"`, the shell runs whatever sits between backticks
  and inside `$(…)` before planny ever sees it. The command really runs,
  and the body keeps an empty space where the text should be. Write such
  bodies to a file with a quoted heredoc delimiter, then pass the file:

  ```bash
  cat > /tmp/body.md <<'EOF'
  Run `npm test` and check $HOME is set.
  EOF
  planny add "Check the test run" --desc-file /tmp/body.md
  ```

  Single quotes around `-d` are safe too, but then the body can hold no
  single quote of its own. Prefer the file.
- **Fields at creation, not later**: `--kind` (ai or operator), `--model`
  when particular model strengths suit the work, `--parent` to place it in
  the hierarchy, `--blocked-by` / `--blocks` for real orderings,
  `--priority` when it should not join at the bottom.
- **Structure**: work needing several owners or stages becomes child
  tasks, one owner each. Encode order as dependencies, never as prose
  (`next` reads dependencies, not descriptions — "do this after t7" in
  prose does not hold).
- **Decisions** use the section layout in
  [references/decision-format.md](references/decision-format.md).
- **Take ids from command output — never predict them.** Another writer
  (the operator's UI, a teammate agent) may take the next id at any
  moment; a hardcoded guess can claim someone else's task. When the new
  task is yours to work right now, `planny add "…" --start` creates,
  starts and claims it in one command, with no id to juggle.

Before you add a task, find its place and check it is new. A store
with a hierarchy expects new work to join it: find the parent
(`planny tree` shows the shape) and pass `--parent` — a root-level
task is a deliberate choice, not a default. Then check the work is new: `planny list --status
todo,in-progress` prints one line per task; grep it for the key nouns
and their synonyms. Never use `--json` for this check — it prints whole
bodies (`--json --compact` is the lean form). A duplicate splits one
piece of work across two task histories.

Then sanity-check the plan you just built: `planny tree` (shape),
`planny deps` (order), `planny next` (is the first actionable task the
right one?).

An operator's quick-add often arrives rough — a two-word name, a pasted
thought. When you pick one up, bring it to this standard: rename it to a
short imperative name, and append what done looks like in STE. Keep the
operator's original words in the body; they are the request of record.

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

You will constantly hit questions only the operator can answer; a
decision task is how such a question waits without being lost. A
decision is a task with `--type decision`: a question for the operator
with enough context to answer from the item alone. The operator
answers on their own schedule — later today, next week — through
`planny decide` or the board; they may not be ready to think about it
yet, and the open task is what they come back to. Meanwhile you keep
working everything the answer does not block. When you (the AI) hit a
choice that touches money, production, product trade-offs, an
operational surface, or a pure operator preference — or you are simply
blocked on an answer — create one:

```bash
planny add "Choose the database" --type decision --kind operator \
  --blocks t7 --desc-file decision.md   # or --desc / stdin via -
```

Write the body using the section layout in
[references/decision-format.md](references/decision-format.md) — read it
before writing your first decision. Blocked work gets `--blocked-by` pointing
at the decision, so the queue shows what each answer unlocks. After a
resolution, dependants wait on the outcome task instead.

**New ideas, which carry doubts, become a decision task first.** When you are unsure an
approach is right, when you have flagged risk or downsides, or when
the operator has expressed concern, turn the work into a decision task
before any agent builds it. Your own ideas are not exempt: if you
doubt an idea as you record it, record it as a decision, not a plain
`ai` task. A doubt written as a sentence inside a plain task protects
nothing — `planny next` still serves that task, and an agent will
build it; only a decision task holds the work until the operator
answers. If a plain task for the work already exists, there are two
ways in: convert it to a decision when the whole task is really a
question (`planny update <id> --type decision --kind operator`), or
add a separate decision that blocks it when the task is agreed work
with one open question inside it. The commands and layout live in
[references/decision-format.md](references/decision-format.md).

### Working the decision queue

- `planny decisions [--json]` lists open decisions in answering order
  (unblocked first, then priority; a decision that blocks another sorts
  above it automatically).
- Present one decision to the user at a time: name, then the body verbatim.
- The user answers → `planny resolve <id> --response "<their words>"`
  (`--accept` takes your proposal; `--response-file` reads long answers;
  `--reject` closes a decision as decided-no and creates nothing).
- A resolution creates an **outcome task**: a child of the decision
  carrying the answer and the decision text — the answer cannot be lost
  while that task is open. Tasks that waited on the decision are rewired
  to wait on the outcome task, so work that waited on the decision
  keeps waiting until the answer is interpreted. **Work it like any task**: update or cancel the
  rewired tasks to match the outcome, and create the follow-on tasks it
  calls for, each citing the decision in its body ("Decided in t150").
  Before you mark the outcome task done, append a record that starts
  `Subsequent actions:` and says what you did with the answer — the
  tasks you spawned and what each covers, or why no work was needed.
  The operator reads that line to see the answer landed; the later
  `Consequences:` record on the decision says how it shipped. Marking the
  outcome task done releases the waiting work.
- The user skips → move on; the decision stays open.
- After the decided work ships, append the record the operator will look
  back on: `planny update <id> --append-desc "Consequences: … Files: … Tests: …
  Tasks: … How to test: … Runs at: …"`.
- `planny decide` is the operator's own interactive loop; don't run it
  yourself. When you are in the loop, you resolve for the operator and
  then work the outcome task, as above.

### Staying current

Catch up at boundaries — when you start work, between tasks, and before
choosing what to do next. Never mid-task: the delta's job is to steer
your next choice of work, and mid-task that choice is already made.
Read it while deep in a task and it only crowds the task's details out
of your working memory. Finish or park the task, then catch up.

- `planny catchup --json` is the default (it uses your `PLANNY_SESSION` as
  the consumer id; `--as <id>` overrides). It returns every task changed
  and every decision resolved since you last asked, then advances your
  stored cursor — you carry no state. `--peek` looks without advancing.
  You can meet the same change in two deltas: never missed, sometimes
  repeated. Each entry states a current fact ("t12 is done"), so a
  repeat is harmless. But each delta is handed out only once — a plain
  `catchup` advances the cursor even when you discard its output — so
  never pipe it through `head` or `grep`. Extract from the JSON with a
  JSON-aware tool (jq, a script), or ask for `--compact` (ids, names,
  statuses and stamps only, sized to be read whole), and use `--peek`
  when you only want to look. Only an explicit
  `--since` window can recover what a truncated read threw away.
  A resolved decision's follow-on work is its outcome task: the resolved
  entry names it, `planny next` surfaces it, and the decision body cites
  its id.
- Explicit windows, when a cursor is not what you mean:
  `planny decisions --resolved --since <time> --json` (answers, each with
  the tasks it unblocked) and `planny list --changed-since <time> --json`.
- One task's own timeline needs no store-wide diff: its typed `history`
  logs every status change, priority move, re-parent, dependency edit and
  rename with `{at, …, by}` — `planny show <id>` prints it, `--json`
  returns it.
- Skip your own footprints: entries whose `by` (in `history`/`created_by`)
  starts with your own `PLANNY_SESSION` id are changes you already know
  about.
- There is no agent-facing watch mode, deliberately. File watching exists
  only as harness plumbing (the serve UI's live refresh); an agent that
  polls or subscribes mid-task is doing it wrong.
- While catching up, also run `planny next --kind operator` and tell the
  operator what is waiting on them — operator tasks move only when a
  human sees them.

## Priorities

Priority is one ordered list (position 1 = top). `bump` moves the task to
the nearest allowed position: a task never ranks above an active task that
blocks it, and the tool repairs the order when dependencies change. Trust
the order; don't fight it by renumbering.

## Reference

Statuses: `todo`, `in-progress`, `parked`, `done`, `cancelled` (cancelled
tasks keep their file; `--replaced-by` rewires dependants onto the
successors). A parked task is real work, but not for now: it keeps its
priority place and still blocks whatever waits on it, and only `next` and
`decisions` pass it over. `--include-parked` shows it again; `planny todo`
wakes it.
Kinds: `ai`, `operator` by convention (free-form for new kinds); `--model`
records a preferred model, advisory only — when you hand out the task,
pick another model if that one is unavailable.
Updating: `npm update -g planny` refreshes the CLI and this skill together
— the skill ships inside the npm package, so a skills directory that
symlinks it follows automatically; a plugin install updates through its
marketplace instead.
Reading the plan — the exact query for each question:

- What is left to do? `planny list --status todo,in-progress --json`
  (add `--kind`, `--type`, `--model`, `--changed-since` to slice;
  `--compact` drops the bodies).
- What should be worked on now? `planny next [n] --json` — each item
  carries the task, its ancestor path, and the tasks it unlocks.
- How does task X relate to everything? `planny show X --json` — fields
  `ancestors` (parent chain, nearest first), `children`, `blockedBy`,
  `blocking`, and a `blocked` flag. The text form prints the same facts
  as labeled lines: path, children, waits on, blocks.
- Children of X? `planny list --parent X`; the whole subtree:
  add `--recursive`.
- What is blocked right now? `planny list --blocked` (and `--unblocked`
  for the opposite).
- The shape at a glance: `planny tree` (hierarchy), `planny deps`
  (blockers above what they block), `planny progress [--parent X]`
  (completion).
- The file behind a task: `planny path X`.
`planny doctor [--fix] [--json]` checks a store that may have been edited
by hand or broken by a git merge or checkout (dangling ids, cycles,
duplicate ranks, stale statuses, unresolved merge conflicts) and repairs
the problems that have one right answer; it exits 1 while errors remain.

This file covers the common paths, not every flag. The full reference is
`planny <command> --help`: every command documents its options and carries
examples, and it cannot drift from the binary.

A bug in planny itself goes upstream: add a task to your own plan to open
the issue or PR at <https://github.com/iAmMichaelConnor/planny>.
