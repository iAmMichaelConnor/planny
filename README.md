# planny

A CLI task and decision tracker for projects where AI agents do the work and
a human (the operator) steers. It replaces the ever-growing `plan.md` — and
the `DECISIONS.md` beside it. Tasks and decisions live as one markdown file
each. The plan stays current because updating it is one cheap command, and
an agent loads only the tasks it needs instead of a whole document. Any
questions raised by agents queue up as decisions, and the human works through
them in their own time — none get lost.

## Why

I found that the PLAN.md pattern was becoming very unwieldy when
running local, multi-agent sessions. AI started getting confused about
what tasks were done and what were left to do. AI would append lots of
information to the plan and sometimes it would conflict and confuse.
Sometimes it would forget to mark tasks as done. It also didn't really
give a priority hierarchy or help me understand which tasks block
others, or which tasks are subtasks of others.

I also find it very useful to have AI track any outstanding decisions
that it wants me to make. I had a DECISIONS.md, but that too became
unwieldy and messy. Outstanding decisions were hard to identify and
understand, or they'd just get lost or forgotten.

Altogether, it gobbled up loads of tokens and wasn't very reliable.

I've been using it for local development for a bit, and AI does
seem to be better at tracking its tasks and working across agents with
this. And it helps me understand what outstanding decisions I need to
work through async, in order to unblock tasks. It doesn't replace
tracking of larger project items between humans, but it does help with
the new, zoomed-in fractal of me orchestrating project management
between agents (and me) on my own local machine.

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

```text
Set up planny in this project:
1. Make sure the planny CLI is installed: npm install -g planny
2. Give yourself the planny skill: link $(npm root -g)/planny/skills/planny
   into your skills directory — ~/.claude/skills/ for Claude Code,
   ~/.codex/skills/ for Codex, or wherever your agent reads the open
   SKILL.md format.
3. Run planny init.
From now on, use the planny skill for every task and decision.
```

Or by hand — the npm package ships the skill, so link it from the
installed package and it stays current across upgrades:

```bash
mkdir -p ~/.claude/skills   # Codex: ~/.codex/skills
ln -s "$(npm root -g)/planny/skills/planny" ~/.claude/skills/planny
```

Restart the agent to pick up new skills; for a per-repo install, link
into the project's `.claude/skills/` (Claude Code) or `.agents/skills/`
(Codex). Claude Code can also take the plugin route instead — the repo
doubles as a plugin marketplace (`/plugin marketplace add
iAmMichaelConnor/planny`, then `/plugin install planny@planny`). Either
way the CLI itself still comes from npm — the skill is the primary
instructions, and every command's `--help` teaches the rest.

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
Agents constantly hit questions only their human can answer; a decision
task is how such a question waits without being lost. You answer on
your own schedule — later today, next week — through `planny decide`
or the board, and until then agents keep working everything the answer
does not block. A question that lives only in chat scrolls away; an
open decision task is what you come back to when you are ready to
think about it.
`planny resolve` appends the answer under `## Outcome`, so resolved
decisions double as a browsable decision log — and it creates an
*outcome task* as the decision's child, carrying the answer as work an
agent picks up, so a resolution cannot be lost. `--reject` closes a
decision as decided-no and creates nothing.

**Attribution.** `planny --session <id> <command>` — or
`export PLANNY_SESSION=<id>` once per shell — records who acted. Creates
stamp `created_by`; every status change, priority move, re-parent,
dependency edit and rename appends a one-line history entry `{at, …, by}`.
Session ids are hierarchical: an orchestrator passes its id to subagents
(environment inheritance does this for free) and may suffix per child
(`sess-abc/builder`); ids sharing the root before the first `/` are one
team. The web UI attributes its changes to `operator`. `--project <name>`
(or `PLANNY_PROJECT`) makes every command refuse a store whose directory
name differs, so an agent's wrong `cd` cannot touch the wrong plan.

**Claims.** `start` claims a task. Starting one that a different team holds
is refused until `--take`, which records the takeover in history. The
current holder shows as "started by …" in `show`, `next --json` and the UI.

**Concurrency.** Every mutation runs inside an advisory cross-process lock
(`.planny/lock`, stale locks self-heal), so two CLIs, or the CLI and the
serve UI, cannot interleave and drop writes.

## The localhost UI

The CLI is the main tool — it is what your agent uses. `planny serve`
adds a localhost UI as a bonus for humans:

- **Track what the AI is doing.** The board updates live as your agent
  works — tasks change columns the moment their status changes.
- **Add or edit tasks without interrupting your agent** (although you
  can also just ask your agent).
- **Read through and resolve the outstanding project decisions your
  agent has asked you**, one at a time, in answering order (or, again,
  just tell your agent your answers).

![The board](https://raw.githubusercontent.com/iAmMichaelConnor/planny/main/docs/planny-board.png)
*The board — this screenshot is planny tracking its own development.*

![The tree view](https://raw.githubusercontent.com/iAmMichaelConnor/planny/main/docs/planny-tree.png)
*The tree view, on a small demo store — per-parent progress, holders,
models, and waits-on links.*

![The decision queue](https://raw.githubusercontent.com/iAmMichaelConnor/planny/main/docs/planny-decisions.png)
*The decision queue — methodically work through each outstanding
decision that your agent has asked of you.*

![The edit drawer](https://raw.githubusercontent.com/iAmMichaelConnor/planny/main/docs/planny-drawer.png)
*The edit drawer, docked on the right.*

The detail, for the curious: four views — a kanban board (columns in
priority order, global `#position` on active cards), a tree of parents
and children with per-parent progress, a dependency graph with a
switchable reading (`A blocks B` / `A is blocked by B` — labels, arrows
and layout all flip), and the decision queue with respond / accept /
skip. Filter chips slice every view by status, kind and type. The edit
drawer covers every CLI action, docks to either side or the bottom, and
resizes. The server watches the store and pushes events to open tabs, so
CLI edits appear without a reload; refreshes never clobber a half-typed
form. One status colour code runs through every view. The UI is three
static files (`web/`), no framework, no build step.

From inside an agent session, start the server with `planny serve
--detach`: it launches the server in its own OS session and prints the
URL once the board answers. Agent harnesses tie background tool tasks
to the session and reap them at session end or context compaction,
taking a plain backgrounded `planny serve` with them; the detached form
survives. `planny serve --stop` ends it. From your own terminal, plain
`planny serve` is fine.

## Quickstart

```bash
planny init
planny add "Build the importer" -d "Parse the CSV and load rows."
planny add "Write importer tests" --parent t1 --model opus
planny add "Deploy importer" --blocked-by t1
planny add "Choose a hosting provider" --type decision --kind operator --blocks t3
planny start t1                        # claims t1 for your session
planny next                            # what to work on now, in priority order
planny show t3                         # one task in full: body, relationships, history
planny update t2 --add-blocked-by t1   # the tests wait on the build
planny bump t3 top                     # clamped: never above the tasks it waits on
planny done t1
planny decisions                       # what the operator still needs to answer
planny resolve t4 --response "Fly.io"  # record the answer; t3 now waits on the outcome task
planny tree                            # the hierarchy at a glance
planny deps                            # blockers above the tasks they block
planny progress                        # █████░░░░░░░░░░░░░░░ 25% — 1/4 done…
planny export --out plan.md            # the whole plan as one document
planny serve                           # localhost UI: kanban, tree, deps, decisions
planny url                             # where that UI is being served
```

## Command reference

| Command | Does |
| --- | --- |
| `init` | create the `.planny` store |
| `add <name>` | add a task: `-d`/`--desc-file`, `--type task\|decision`, `--kind`, `--model`, `--parent`, `--child`, `--blocked-by`, `--blocks`, `--priority top\|bottom\|N`; `--start` claims it in the same command |
| `update <id>` | change any field or relationship (`--add-blocked-by`, `--clear-parent`, `--append-desc`, …) |
| `start <id> [--take]` | mark in progress and claim it; `--take` takes over another session's claim |
| `done` / `todo <id>` | finish / reopen (also wakes a parked task) |
| `park <id> [--until "<note>"]` | park a task: real work, but not for now. It keeps its priority place and still blocks; only `next` and `decisions` pass it over |
| `cancel <id> [--replaced-by ids]` | cancel; dependants are rewired onto the replacements |
| `bump <id> top\|bottom\|N` | move in the priority order, clamped by dependencies |
| `show <id> [--json]` | one task in full: fields, body, relationships, history, file path |
| `list [filters] [--json]` | flat priority-ordered list; filter by status, kind, type, model, parent (`--recursive`), blocked, `--changed-since <t>` |
| `next [n] [--kind] [--under id] [--include-parked] [--json]` | unblocked leaf tasks to work on now, with ancestor paths, unlocks and holders |
| `tree` / `deps` | hierarchy view / dependency view in the terminal |
| `progress [--parent id]` | completion percentage (excludes cancelled) |
| `export [--out plan.md]` | the plan as one markdown document |
| `decisions [--include-parked] [--json]` | open decisions in answering order; `--resolved [--since t]` lists answered ones newest first, with what each unblocked |
| `catchup [--as id] [--peek] [--compact]` | everything changed since this consumer last asked, then advance its stored cursor; `--compact` trims to ids, names, statuses and stamps |
| `resolve <id> --response …\|--accept\|--response-file f\|--reject` | record the answer, mark done, create the outcome task (`--reject`: close as decided-no, create nothing) |
| `doctor [--fix]` | integrity checks for hand-edit damage; `--fix` repairs what has one right answer; exits 1 while errors remain |
| `path <id>` | print the task's file path |
| `serve [--port] [--detach] [--stop] [--clean-logs [--older-than d]]` | localhost control site (127.0.0.1 only); with no `--port` it takes the port this store used last, else the first free one from 5891, so two stores never collide; `--detach` outlives the launching (agent) session, `--stop` ends the detached server, `--clean-logs` deletes this store's dead old log |
| `url` | print the address where the UI serves this store; exits 1 when it is not up |

Every command's `--help` carries examples; mistyped commands get a
did-you-mean suggestion.

### Staying current

`planny catchup` keys a cursor to the asking consumer (default: your
`PLANNY_SESSION`) and returns every task changed and every decision
resolved since that consumer last asked — the agent carries no state;
`--peek` looks without advancing, `--compact` trims the payload. Explicit
windows do the same for a time you name: `list --changed-since <t>` and
`decisions --resolved --since <t>`. You can see the same change twice —
never missed, sometimes repeated — so treat each entry as a current fact,
safe to read again. One task's own timeline is its history: `planny show`.

## Storage

The `planny` binary is global; the plan is not. Every command resolves the
nearest `.planny` directory above the current working directory, exactly as
git resolves a repo, and human-readable views print `store: <root>` as their
first line so there is never doubt which project answered.

One exception, because a project has one plan: inside a linked git
worktree, planny defers to the main worktree's store. A checkout of a
tracked `.planny` is a copy of the plan, not a plan of its own — using it
would fork ids and statuses that a branch merge cannot cleanly reunite,
so discovery redirects (and says so on stderr), agents in worktrees write
the same plan through the same lock, and `serve`/`url` name one board.
Create a `.planny/fork` file in the worktree to keep a deliberate,
separate plan; `planny init` there refuses without it.

`.planny/tasks/<id>.md`, one file per task — commit the directory; the plan
travels with the repo. Treat those commits as snapshots of one lineage:
merging branches whose stores diverged is not supported (both sides mint
the same next id for different tasks, among subtler damage — `planny
doctor` names an unresolved merge when it sees one), and planny warns on
stderr when a checkout or restore hands it a store older than what this
machine last wrote — `planny doctor` then prints the recovery steps.

Two design choices worth knowing:

- **Flat directory, not a tree.** Hierarchy is a field, not a directory
  structure, so re-parenting never moves a file and ids and paths stay
  stable. The tree is a view: `planny tree`, the export, the UI.
- **Markdown files, not a database.** Agents grep and read files well,
  diffs review well, and damage from a bad merge stays contained to
  single files. Reading raw
  files is encouraged; writing goes through the CLI, which keeps
  relationships one-sided, refuses cycles, and holds the priority
  invariant. `planny doctor` catches hand-edit damage after the fact.

Beside `tasks/`, the store holds a few transient files git should
ignore: `serve.json` and `serve.log` (the detached server's record and
output — `serve --stop` names the kept log, and `serve --clean-logs`
deletes it once the server is gone and the file is older than seven
days, `--older-than <days>` to taste; other projects' logs are never
touched), `lock`, and `last-seen.json` (the rewind tripwire: the
newest state this machine has written — delete it to acknowledge a
deliberate rewind).

## Troubleshooting

Store trouble almost always comes from git or from hand edits.
`planny doctor` is the diagnostic for all of it: every finding carries
its own fix, and `--fix` applies the repairs that have one right
answer.

- **"the store looks older than what this machine last wrote"** — on
  stderr, from any command. A git checkout or restore handed planny an
  older snapshot of the plan. Run `planny doctor`: its `store-rewound`
  finding prints the recovery commands — find the newer snapshot with
  `git log --all --oneline -- .planny`, bring it back with
  `git checkout <commit> -- .planny`, or delete
  `.planny/last-seen.json` to accept the rewind.
- **"unresolved git merge conflict"** — you merged branches whose
  stores had diverged. Resolve the merge; the reliable way is to keep
  one side's `.planny` whole and re-apply the other side's changes
  through the CLI. Then run `planny doctor --fix` for the leftovers.
- **A command refuses a task file** — unreadable, or "frontmatter says
  id … but the filename says …". The file was edited or copied by
  hand. `planny doctor` lists every broken file; repair it by hand or
  restore it from git, then rerun doctor.
- **Dangling references, duplicate ranks, or order violations after a
  merge** — a clean textual merge can union two valid stores into an
  invalid one. `planny doctor --fix` repairs these; cycles it only
  names, for you to break with `planny update`.
- **Garbled `cursors.json` or `last-seen.json`** — `planny doctor
  --fix` resets them; both rebuild themselves afterwards.

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

**Releases.** Bump the version in `package.json`, build, test, commit,
tag `vX.Y.Z`, push the commit and the tag, then trigger the *Publish to
npm* workflow by hand (`gh workflow run publish.yml`, or the Actions
tab). Publishing authenticates with [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers) via OIDC:
npmjs.com trusts this exact repo and workflow file, so no npm token or
secret exists locally or in CI, and provenance is generated
automatically. The npm package carries the CLI, the web UI and the
skill, so one publish updates all three for `npm update -g planny`
users.
