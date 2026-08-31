# Founding prompt

The prompt that started this project, kept verbatim (2026-08-31):

---

I want to create a cli tool to enable ai (claude, codex, etc) to track tasks for a local project. The problem being solved is that a plan.md can quickly grow verbose and messy, as new tasks are added, and as completed tasks aren't kept up to date, and as task requirements change, and as priorities shift. This can lead to a confused ai. It can also cost too many tokens for the ai to load the plan and to update the plan with what's been done, or to move around priorities. To tool should be simple, with the following features and requirements:
- Add new task, with task name, detailed description, priority, parent task, child tasks, "blocked by" tasks, "blocking" tasks (some of these things being optional).
- Update features of a task (name, description, priority, parent task, child tasks, blocked-by tasks, blocking tasks...)
- You can see that tasks have relationships to other tasks, so hierarchies can be formed. Parent/child relationships are a way of breaking a task into smaller tasks. Blocked-by/blocking tasks reveal an ordering about which tasks need to be tackled first.
- Sometimes a task will be something for an ai to do; sometimes a task will be something for the user (aka the operator) to do, e.g. awaiting an operator decision or action. Sometimes an ai task will be blocked by an operator making a decision, or an operator running a command that only the operator can do, or an operator doing something that only an operator can do. So I guess we'll need a high-level task "owner" or task "kind". Maybe "ai" and "operator"; maybe it'll evolve into more kinds over time. E.g. a type of model to own. Maybe a task will require multiple ai's/operator owners (e.g. planning, doing, reviewing), in which case it probably needs to be broken into smaller tasks; each with an owner.
- Some tasks will also lend themselves to certain models, since different models have different capabilities, so perhaps "owner" needs to be split into different kinds of ai model that the user has available? Or maybe "ai" owner has a subcategory of "model" to convey the model. Sometimes a preferred model won't be available (e.g. due to tokens running out), so a different model will be needed at the time the task is loaded.
- Mark tasks as done.
- Mark tasks as todo.
- Mark tasks as in progress.
- Mark tasks as cancelled (where it can be specified that the task has been replaced by one or many other tasks, where applicable).
- The ability to create a md file from the plan's many tasks:
    - A bullet-pointed list of tasks, where child tasks are indented bullet points. The option to output all tasks, or some combination of statuses (todo, in progress, done).
    - Dependencies: a bullet-pointed list where the indentations relate to the blocked-by/blocking type, showing which tasks block / are blocked by others. Maybe a bullet-pointed list isn't sufficient, and it needs to be some tree view or graph or something?
    - Actually, not just md as an output type, but also output to the terminal, as an option.
    - Also outputtable to a very minimal localhost site. In fact, the user should also be able to use the localhost site to _control_ the tasks. It should have a kanban view, a hierarchy view (parents and children) and a hierarchy view of blocked-by/blocked. It should have ui controls for all the cli actions that can be done to tasks.
- The priority of a task can be bumped by the user to the top of the list, or back of the list, or some other position, as long as it doesn't violate any blocking/blocked-by dependencies (and if it does, move it to the nearest possible position to the user's request). 
- There must be a skill which teaches ai about this cli tool, so that it can use it effectively.
- Also, an ai project is not just tasks that belong to a plan. There's also outstanding decisions that need to be worked through. I guess you can think of an outstanding decision as a special type of task (since a decision task can block / be blocked by other tasks, and can have parents/children, etc), and we will indeed treat it as such. So have a "decision" type that can be attached to a task. A decision is a special type of task, in the sense that a human user (operator) will be asked a question, so they'll need to be given lots of context. An ai which creates a decision task needs to provide a lot of important detail (more on the structured layout of a decision task below). For completed decisions, a user must be able to look back over them, and they should be embellished with what the decision was, why that decision was made, what has been built, where to look (filepaths), tests written, how to test, where it runs (where applicable). 
- Some rules for writing a decision task entry:
- Use Simplified Technical English (STE), the ASD-STE100 style, applied in
  spirit rather than checked against the STE dictionary: short sentences,
  active voice, one meaning per word, plain words. Never use project
  shorthand without a definition: a term either appears in the "Background
  terms" block or is explained where it is used.
- Make every item self-contained: the operator must be able to decide
  from the item alone, without opening another doc. Keep pointers to the
  fuller write-ups in a parenthetical before the ask.
- Structure every operator item under these subheadings, in this order. A heading with nothing true or meaningful or valuable to
  say is omitted, never padded. A ratification item
  also states what changes if the answer is no.
  - **Background** — what the thing is, what the problem is, what raised the question, and
    what forces a choice now. Background terms defined. For a ratification: what is built, tested,
    and where it runs.
  - **Why this comes to you (the operator)** — what makes the choice contentious, or
    what it touches that only the operator owns: money or token spend,
    production data, an operational surface the operator uses, critical code, a product
    trade-off, a risk only the operator can accept. An ai agent can attack a "proposal" to a decision task (a recommendation) to make the operator's life easier.
  - **Proposal** — the recommended answer and its reason, with its pros
    and cons weighed honestly as *Pros:* / *Cons:* subheadings. Where there is
    no single recommendation, **Options** instead, each option carrying
    its own pros and cons. A multi-part item labels each part
    **Proposal (a)**, **Proposal (1)**, and so on, each with its own
    *Pros:* / *Cons:* / *Ruled out:* subheadings.
  - **No proposal yet** — a question put to the operator with no
    recommendation attached, saying what stops the session from forming
    one (a pure preference of the operator's, or a fact still missing).
    Most decisions should arrive with a Proposal; this heading is the
    exception, and its presence is a flag (operator, PROMPT #275).
  - **Alternative options** — alternatives considered (aside from the recommended proposal), each
    with the reason and pros & cons, so the operator can re-open one deliberately
    instead of re-deriving it blind.
  - **Needed from you** — the exact question or go, answerable in a word
    or two where possible.
  - **When** — the moment the answer is needed, and what waiting costs.
- I don't think the tool should enforce mandatory entries for those listed sections of a decision entry, yet. It should just make it clear to ai that it should layout a decision entry's markdown with those sections, and we can trust ai to enter content well.
- Tasks should also follow the simplified technical english paragraph.
- I think perhaps the tool should store background data as a file tree of md files. What do you think? That way, things will be navigable. Child tasks can be within a child directory. This will also enable ai to navigate the raw md files easily as well. Or maybe nested json files is better, since a task has structured data which can be put in a neat json format (including free-form md syntax as big strings). Or maybe this is a bad idea and you'd prefer some kind of db, but I'm not sure if ai can navigate a db well. We should think about this.
- A user should be able to ask ai "let's work on this task or project (a parent task) now", and it should be able to load the tasks and execute them, and refer to tasks with some pointers that are native to the tool. 
- So I guess tasks need ids, and maybe also filepaths (but bear in mind a filepath might change as children and parents are changed by the user or by the ai). 
- A user/ai should also be able to ask what the next task (or n tasks) should be worked on next, and should be given data about how those tasks relate to each other, and the path (parents/ancestors) the tasks lie on. An ai might wish to give tasks which all live under a common parent or ancestor to the same agent.
- The project should have a skill.md which explains to ai how to use the tool effectively. You'll need to follow best practice for creating skills. There's a ~/writing-skill which has a layout that could come in handy there, or you could also follow inspiration online from reputable and popular skills only. 
- A user should be able to work through decisions one-by-one, in priority order (based on the priorities of the decision tasks, and based on which decisions block other actions or decisions -- noting that priority should reflect which items are blocked; a task which is blocked by another should not be a higher priority than the task which blocks it). The cli should have this feature, and the user should be able to provide a response (their decision, free-form text, which could be custom, or agreeing to a proposal from ai) or a preference to skip for now, in which case we'd move on to the next decision. The ui should also have something similar. And ai should be taught how to use this cli feature to work through decisions, but if the ai uses it, it can interpret the user's decision response immediately. I suppose there should be cli getter commands: getting tasks by id, by parent (all children of a parent, or even all descendants of a parent), getting all tasks (filterable by status), etc etc. Maybe db query syntax is good, instead, though. I guess it depends how you think this should be designed. I'm mindful that ai is very good at reading through filepaths, so hiding things in a db might be bad. I'm not sure. Or maybe a dual db and files system could work. I'm not sure.
- Keep this prompt verbatim in a md file. Make a readme for this project. It's a shame the tool itself doesn't exist yet, because there are so many tasks and outstanding decision relating to this project itself, it would have come in useful. 
- Wherever ai has a question, this should be added as a decision task (the skill should make this clear). The skill can be a part of this repo. Oh, yes we're creating a repo within this dir for this project. Don't push anything yet. You may commit at clean moments of progress. Whenever the user says "add a task" (or some other instruction relating to a task), the ai should know to use a particular command of the cli tool to do the action. So the skill might need a decision tree or something to make it clear how to behave depending on certain actions that the user wants.
- There should be very good tests. Add the following as a testing philosophy for this project:
### Testing philosophy

**Red-green-refactor is the law.** Every feature and bug fix follows this cycle strictly:

1. **Red** — Write a failing test first. Run it. Watch it fail. If it doesn't fail, your test is wrong. The failure message must clearly describe what's broken — if you can't tell what went wrong from the output, rewrite the assertion.
2. **Green** — Write the minimum code to make the test pass. Not the "right" code. Not the "clean" code. The *least* code that turns red to green. Resist the urge to generalize.
3. **Refactor** — Now clean up. Extract helpers, rename, restructure — but only while tests stay green. If a refactor breaks a test, you went too far. Back up.
4. **Harden** — Ask: "what would break this?" Add that case. Repeat until you can't think of anything. Edge cases, error paths, boundary values, concurrent access.. You might want to make a skill / claude.md / agents.md for this - i don't know which is best.
- The code you write should be clean, well modularised, maintainable, no spaghetti. Don't create duplicate codepaths if a well-designed codepath already exists. If the existing codepath isn't well-designed, update it rather than creating an additional codepath which would add clutter.
- The cli should be able to output a progress percentage. And maybe the ui (localhost) too. The ui progress could also be showable by parent (for every nested parent). The ui should have a page which is like a tree view (like a file tree) of parents and child tasks. It should be filterable / sliceable by task properties. It should be sortable by priority. There should also be a graph view of blocked-by/blocking tasks. Maybe the parent-child tree view could also somehow visually show dependencies (re blocked-by/blocking). Maybe a file tree view of blocking (higher level of the tree view) to blocked (lower). Not sure. Try all and other approaches if you think they'd be useful.
