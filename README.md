# planny-wanny

A CLI task and decision tracker for projects where AI does the work and a
human (the operator) steers. It replaces the ever-growing `plan.md`: tasks
live as one markdown file each, the plan stays current because updating it
is one cheap command, and an AI loads only the tasks it needs instead of a
whole document.

Each task has a stable id, a status, a priority, an owner kind (`ai` or
`operator`), an optional preferred model, a parent, and blocked-by links.
Decisions — questions only the operator can answer — are tasks too, with a
structured body and their own queue.

## Install

```bash
npm install
npm run build
npm link        # puts `planny` on your PATH
```

Node 20+. Then, in any project: `planny init`.

## Quickstart

```bash
planny init
planny add "Build the importer" -d "Parse the CSV and load rows."
planny add "Write importer tests" --parent t1 --model opus
planny add "Deploy importer" --blocked-by t1
planny add "Choose a hosting provider" --type decision --kind operator --blocks t3
planny start t1
planny next            # what to work on now, in priority order
planny done t1
planny progress        # ████░░ 33% — 1/4 done…
planny serve           # localhost UI: kanban, tree, dependency graph, decisions
```

## Commands

| Command | Does |
| --- | --- |
| `init` | create the `.planny` store |
| `add <name>` | add a task: `-d`/`--desc-file`, `--type task\|decision`, `--kind`, `--model`, `--parent`, `--child`, `--blocked-by`, `--blocks`, `--priority top\|bottom\|N` |
| `update <id>` | change any field or relationship (`--add-blocked-by`, `--clear-parent`, `--append-desc`, …) |
| `start` / `done` / `todo <id>` | set status |
| `cancel <id> [--replaced-by ids]` | cancel; dependants are rewired onto the replacements |
| `bump <id> top\|bottom\|N` | move in the priority order, clamped so a task never outranks its blockers |
| `show <id> [--json]` | one task in full: fields, body, relationships, file path |
| `list [filters] [--json]` | flat priority-ordered list; filter by status, kind, type, model, parent (`--recursive`), blocked, `--changed-since <time>` |
| `next [n] [--kind] [--under id] [--json]` | unblocked leaf tasks to work on now, with ancestor paths and what they unlock |
| `tree` / `deps` | hierarchy view / dependency view in the terminal |
| `progress [--parent id]` | completion percentage (excludes cancelled) |
| `export [--out plan.md]` | the plan as one markdown document |
| `decisions [--json]` | open decisions in answering order; `--resolved [--since t]` lists answered ones newest first, with what each unblocked |
| `catchup [--as id] [--peek]` | everything changed since this consumer last asked, then advance its stored cursor (`.planny/cursors.json`) |
| `decide` | interactive: step through decisions, answer or skip |
| `resolve <id> --response …\|--accept` | record the operator's answer, mark done |
| `path <id>` | print the task's file path |
| `doctor [--fix]` | check the store for hand-edit damage (dangling ids, cycles, rank clashes, …); `--fix` repairs the safe ones; exits 1 while errors remain |
| `serve [--port]` | localhost control site |

Ids accept a bare number (`planny done 3`).

Attribution: `planny --session <id> <command>` (or `export PLANNY_SESSION=<id>`
once per shell) records who acted — creates stamp `created_by`, and every
status change appends `{at, status, by}` to the task's `history`. The
localhost UI attributes its changes to `operator`.

## Decisions

A decision task carries enough context for the operator to answer from the
item alone: Background, Why this comes to you, Proposal (with honest pros
and cons), Alternative options, Needed from you, When. The format lives in
[skills/planny/references/decision-format.md](skills/planny/references/decision-format.md).
`planny decide` walks the queue — blockers first — and `planny resolve`
appends the answer under `## Outcome`, so resolved decisions double as a
decision log.

## The localhost UI

`planny serve` starts a site on 127.0.0.1 with four views: a kanban board, a
filterable tree of parents and children with per-parent progress, a
dependency graph (blockers left of what they block), and the decision queue
with respond / accept / skip. Every CLI action is available from the edit
drawer. The UI is three static files (`web/`), no framework, no build step.

## Storage

`.planny/tasks/<id>.md` — one file per task: YAML frontmatter for the
structured fields, markdown body for the description. Commit the directory;
the plan travels with the repo.

Two design choices worth knowing:

- **Flat directory, not a tree.** Hierarchy is a field (`parent`), not a
  directory structure, so re-parenting a task never moves a file and ids and
  paths stay stable for the life of the project. The tree is a view:
  `planny tree`, `planny export`, the UI.
- **Markdown files, not a database.** AI agents grep and read files well,
  diffs review well, and merge conflicts are one task per file. Only one
  side of each relationship is stored (`parent`, `blocked_by`); the inverse
  sides are derived, so the two can never disagree.

## The skill

[skills/planny/SKILL.md](skills/planny/SKILL.md) teaches an AI agent when
and how to use the tool: an action map from user phrasing to commands, the
work loop, and the decision workflow. Symlink or copy it into a project's
`.claude/skills/` (this repo already does) or your `~/.claude/skills/`.

## Development

```bash
npm test         # vitest: 140+ tests across store, graph, priority, ops,
                 # query, render, CLI, server, and a jsdom UI walk
npm run build    # tsc → dist/
```

Red-green-refactor is the law here; the full testing philosophy is in
[CLAUDE.md](CLAUDE.md). The founding prompt is kept verbatim in
[PROMPT.md](PROMPT.md). This repo tracks its own remaining work in its own
`.planny` store — run `planny list` in the checkout.
