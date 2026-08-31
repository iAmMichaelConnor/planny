# planny

A CLI task and decision tracker for projects where AI agents do the work and
a human (the operator) steers. It replaces the ever-growing `plan.md`: tasks
live as one markdown file each, the plan stays current because updating it
is one cheap command, and an agent loads only the tasks it needs instead of
a whole document.

## Install

```bash
npm install -g planny
```

Node 20+. Then, in any project: `planny init`.

## Give your agent the skill

planny is built to be driven by agents. The skill
([skills/planny/SKILL.md](skills/planny/SKILL.md)) teaches an AI the full
loop: planny as the plan of record (no parallel plan.md or harness todo
lists), an action map from user phrasing to commands, task- and
plan-authoring rules, the decision workflow, claiming and attribution,
staying current, and serving the board at session start.

The fastest install is to paste this at your agent:

> Set up planny in this project: make sure the `planny` CLI is installed
> (`npm install -g planny`); give yourself the planny skill — in Claude
> Code, add the plugin marketplace `iAmMichaelConnor/planny` and install
> the `planny` plugin from it; in Codex or another agent that reads the
> open SKILL.md format, link `$(npm root -g)/planny/skills/planny` into
> your skills directory — then run `planny init` and use the planny skill
> for every task and decision from now on.

Or by hand. Claude Code (the repo doubles as a plugin marketplace):

```
/plugin marketplace add iAmMichaelConnor/planny
/plugin install planny@planny
```

Codex CLI, or any other agent that reads the open SKILL.md format — the
npm package ships the skill, so link it from the installed package and it
stays current across upgrades:

```bash
mkdir -p ~/.codex/skills
ln -s "$(npm root -g)/planny/skills/planny" ~/.codex/skills/planny
```

Restart Codex to pick up new skills; use `.agents/skills/planny` instead
for a per-repo install. Either way the CLI itself still comes from npm —
the skill is the primary instructions, and every command's `--help`
teaches the rest.

## The localhost UI

`planny serve` starts a site on 127.0.0.1 (pictured above) with four
views: a kanban board (columns in priority order, global `#position` on
active cards), a tree of parents and children with per-parent progress, a
dependency graph with a switchable reading (`A blocks B` / `A is blocked
by B` — labels, arrows and layout all flip), and the decision queue with
respond / accept / skip. Filter chips slice every view by status, kind and
type. The edit drawer covers every CLI action, docks to either side or the
bottom, and resizes.

![The board — this screenshot is planny tracking its own development](https://raw.githubusercontent.com/iAmMichaelConnor/planny/main/docs/planny-board.png)

![The decision queue, with the edit drawer docked on the right](https://raw.githubusercontent.com/iAmMichaelConnor/planny/main/docs/planny-decisions.png)

The server watches the store and pushes events to open tabs, so CLI edits
appear without a reload; refreshes never clobber a half-typed form. One
status colour code runs through every view. The UI is three static files
(`web/`), no framework, no build step.

## Quickstart

```bash
planny init
planny add "Build the importer" -d "Parse the CSV and load rows."
planny add "Write importer tests" --parent t1 --model opus
planny add "Deploy importer" --blocked-by t1
planny add "Choose a hosting provider" --type decision --kind operator --blocks t3
planny start t1        # claims t1 for your session
planny next            # what to work on now, in priority order
planny done t1
planny progress        # ████░░ 33% — 1/4 done…
planny serve           # localhost UI: kanban, tree, dependency graph, decisions
```

## Concepts

**Tasks.** One markdown file per task under `.planny/tasks/<id>.md`: YAML
frontmatter for the structured fields, a markdown body for the description.
Ids (`t1`, `t2`, …) are stable for the life of the project and never reused;
commands accept a bare number (`planny done 3`).

**Relationships.** `parent` and `blocked_by` are the stored fields; children
and "blocks" are derived from them at read time, so the two sides can never
disagree. Both hierarchies must stay acyclic — the CLI refuses cycles.

**Priority** is one ordered list (position 1 = top), stored as a sparse
unique rank. The invariant: an active task never ranks above an active task
that blocks it. `bump` clamps to the nearest legal position and every
mutation repairs violations automatically.

**Kind (owner).** `kind: ai` or `kind: operator` says which side of the
human/AI divide owns the task. The field accepts new kinds; only these two
carry conventions (the operator queue, `next --kind`). `--model` records a
preferred model, advisory only.

**Decisions** are tasks with `type: decision`: a question for the operator,
written so they can answer from the item alone (Background / Why this comes
to you / Proposal with honest pros and cons / Alternative options / Needed
from you / When — the format lives in
[skills/planny/references/decision-format.md](skills/planny/references/decision-format.md)).
`planny resolve` appends the answer under `## Outcome`, so resolved
decisions double as a browsable decision log.

**Attribution.** `planny --session <id> <command>` — or
`export PLANNY_SESSION=<id>` once per shell — records who acted. Creates
stamp `created_by`; every status change, priority move, re-parent,
dependency edit and rename appends a one-line history entry `{at, …, by}`.
Session ids are hierarchical: an orchestrator passes its id to subagents
(environment inheritance does this for free) and may suffix per child
(`sess-abc/builder`); ids sharing the root before the first `/` are one
team. The web UI attributes its changes to `operator`.

**Claims.** `start` claims a task. Starting one that a different team holds
is refused until `--take`, which records the takeover in history. The
current holder shows as "started by …" in `show`, `next --json` and the UI.

**Concurrency.** Every mutation runs inside an advisory cross-process lock
(`.planny/lock`, stale locks self-heal), so two CLIs, or the CLI and the
serve UI, cannot interleave and drop writes.

## Command reference

| Command | Does |
| --- | --- |
| `init` | create the `.planny` store |
| `add <name>` | add a task: `-d`/`--desc-file`, `--type task\|decision`, `--kind`, `--model`, `--parent`, `--child`, `--blocked-by`, `--blocks`, `--priority top\|bottom\|N` |
| `update <id>` | change any field or relationship (`--add-blocked-by`, `--clear-parent`, `--append-desc`, …) |
| `start <id> [--take]` | mark in progress and claim it; `--take` takes over another session's claim |
| `done` / `todo <id>` | finish / reopen |
| `cancel <id> [--replaced-by ids]` | cancel; dependants are rewired onto the replacements |
| `bump <id> top\|bottom\|N` | move in the priority order, clamped by dependencies |
| `show <id> [--json]` | one task in full: fields, body, relationships, history, file path |
| `list [filters] [--json]` | flat priority-ordered list; filter by status, kind, type, model, parent (`--recursive`), blocked, `--changed-since <t>` |
| `next [n] [--kind] [--under id] [--json]` | unblocked leaf tasks to work on now, with ancestor paths, unlocks and holders |
| `tree` / `deps` | hierarchy view / dependency view in the terminal |
| `progress [--parent id]` | completion percentage (excludes cancelled) |
| `export [--out plan.md]` | the plan as one markdown document |
| `decisions [--json]` | open decisions in answering order; `--resolved [--since t]` lists answered ones newest first, with what each unblocked |
| `catchup [--as id] [--peek]` | everything changed since this consumer last asked, then advance its stored cursor |
| `resolve <id> --response …\|--accept\|--response-file f` | record the operator's answer, mark done |
| `doctor [--fix]` | integrity checks for hand-edit damage; `--fix` repairs what has one right answer; exits 1 while errors remain |
| `path <id>` | print the task's file path |
| `serve [--port]` | localhost control site (127.0.0.1 only) |
| `url` | print the address where the UI serves this store; exits 1 when it is not up |

Every command's `--help` carries examples; mistyped commands get a
did-you-mean suggestion.

### Staying current

Two styles, one contract. `planny catchup` keys a cursor to the asking
consumer (default: your `PLANNY_SESSION`) and returns every task changed and
every decision resolved since that consumer last asked — the agent carries
no state; `--peek` looks without advancing. Explicit windows do the same for
a time you name: `list --changed-since <t>` and
`decisions --resolved --since <t>`. Delivery is at-least-once: a change in
the same millisecond as a cursor write may repeat, so treat deltas as facts,
safe to see twice. One task's own timeline is its history: `planny show`.

## Storage

The `planny` binary is global; the plan is not. Every command resolves the
nearest `.planny` directory above the current working directory, exactly as
git resolves a repo, and human-readable views print `store: <root>` as their
first line so there is never doubt which project answered.

`.planny/tasks/<id>.md`, one file per task — commit the directory; the plan
travels with the repo. Two design choices worth knowing:

- **Flat directory, not a tree.** Hierarchy is a field, not a directory
  structure, so re-parenting never moves a file and ids and paths stay
  stable. The tree is a view: `planny tree`, the export, the UI.
- **Markdown files, not a database.** Agents grep and read files well,
  diffs review well, and merge conflicts are one task per file. Reading raw
  files is encouraged; writing goes through the CLI, which keeps
  relationships one-sided, refuses cycles, and holds the priority
  invariant. `planny doctor` catches hand-edit damage after the fact.

## Contributing

Install from source:

```bash
git clone https://github.com/iAmMichaelConnor/planny
cd planny
npm install
npm run build
npm link        # puts `planny` on your PATH
```

```bash
npm test         # vitest across store, frontmatter, graph, priority, ops,
                 # query, render, doctor, catchup, lock, CLI, server,
                 # and a jsdom walk of every UI view
npm run build    # tsc → dist/
```

Red-green-refactor is the law here; the full testing philosophy is in
[CLAUDE.md](CLAUDE.md), along with the module map and invariants. The
founding prompt is kept verbatim in [PROMPT.md](PROMPT.md). This repo tracks
its own work in its own `.planny` store — run `planny list` in the checkout.
