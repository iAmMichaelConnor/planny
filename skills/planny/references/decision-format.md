# Writing a decision task body

A decision task asks the operator a question. The operator must be able to
decide from the item alone, without opening another doc. Keep pointers to
fuller write-ups in a parenthetical before the ask.

Write in Simplified Technical English (ASD-STE100) in spirit, not checked
against the STE dictionary: short sentences, active voice, one meaning per
word, plain words. Never use project shorthand without a definition — a term
either appears in a "Background terms" block or is explained where it is
used.

## The sections

Use these subheadings, in this order. Omit a heading with nothing true,
meaningful or valuable under it — never pad one. A ratification item (asking
the operator to confirm something already built) also states what changes if
the answer is no.

- **Background** — what the thing is, what the problem is, what raised the
  question, and what forces a choice now. Background terms defined. For a
  ratification: what is built, tested, and where it runs.
- **Why this comes to you (the operator)** — what makes the choice
  contentious, or what it touches that only the operator owns: money or
  token spend, production data, an operational surface the operator uses,
  critical code, a product trade-off, a risk only the operator can accept.
  Attach a proposal (a recommendation) wherever you can, to make the
  operator's life easier.
- **Proposal** — the recommended answer and its reason, with pros and cons
  weighed honestly as *Pros:* / *Cons:* subheadings. Where there is no
  single recommendation, use **Options** instead, each option carrying its
  own pros and cons. A multi-part item labels each part **Proposal (a)**,
  **Proposal (1)**, and so on, each with its own *Pros:* / *Cons:* /
  *Ruled out:* subheadings.
- **No proposal yet** — a question put to the operator with no
  recommendation attached, saying what stops you from forming one (a pure
  preference of the operator's, or a fact still missing). Most decisions
  should arrive with a Proposal; this heading is the exception, and its
  presence is a flag.
- **Alternative options** — alternatives considered aside from the
  recommended proposal, each with its reason and pros & cons, so the
  operator can re-open one deliberately instead of re-deriving it blind.
- **Needed from you** — the exact question or go, answerable in a word or
  two where possible.
- **When** — the moment the answer is needed, and what waiting costs.

## After the decision

`planny resolve` appends the operator's answer under `## Outcome` and marks
the task done. Then enrich the outcome so the operator can look back over it
later: what the decision was, why, what was built, where to look (file
paths), tests written, how to test, where it runs — where applicable.

```bash
planny update t12 --append-desc "Consequences: the export module shipped. Files:
src/render.ts, test/render.test.ts. Test: npm test. Runs in: the CLI
(planny export)."
```

## Example

```markdown
## Background

The exporter writes plan.md files. Markdown tables do not survive our
linter (the linter rewraps long lines, which breaks table rows). We must
pick an output shape before the docs pipeline ships this week.

## Why this comes to you (the operator)

The docs pipeline is an operational surface you run daily, and the output
shape is a product trade-off readers will live with.

## Proposal

Use nested bullet lists, no tables.

*Pros:* survives the linter; diffs cleanly; renders everywhere.
*Cons:* wide data reads worse than a table.

## Alternative options

Disable the linter for exported files. Ruled out for now: exported files
get hand-edited later, and unlinted edits drift in style.

## Needed from you

"bullets" or "tables"?

## When

Before Friday's docs release; waiting blocks t18 and t19.
```
