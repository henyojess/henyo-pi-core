## How to Use This Plan

### The shape of a plan
- A plan is a checklist of **steps** and **actions**:
  - A **step** is a top-level `Step N` header with its own checkbox.
  - An **action** is a numbered checkbox bullet `N.x` under the step's
    `### Actions` heading.
- **Box state is the only progress record**: unchecked = not done, checked =
  done. Progress is tracked only in this file's checkboxes — an interrupted
  session resumes exactly where it stopped, with no work re-done.
- **Completion:** the plan is complete when no checkbox is left unchecked.
  Count the unchecked steps and actions remaining (by any means available in
  your environment) — zero is the only acceptable final count.
- The plan ends with a `## Final Verification` section. Its boxes are neither
  steps nor actions — they run after the last step, under the same
  execute-then-tick discipline.

> **Execution Discipline — read before starting.**
> Mark each checkbox **immediately after completing that action**. Do not batch-mark.
> One action at a time — discipline over momentum.

## Before You Start

Read this entire plan, in full, before doing anything else.

Then, in your first reply — before any tool call — state:
- In your own words: what this plan changes, and the order of its steps
  (name each step).
- The discipline you will execute it under: how you track progress, and how
  you log `[assumption]` / `[blocker]` / `[deviation]`.
- A commitment: "I will execute this plan as written; any deviation will be
  logged as a `[deviation]` alongside the affected action."

### Execution Loop
1. Find the first unchecked step (its header checkbox is unchecked).
2. Within that step, find the first unchecked action.
3. Do the work described in that action.
4. **Immediately** check that action's box in the plan file, adding
   implementation notes — prefix choices and departures from the plan with
   `[assumption]:` / `[deviation]:`. Checking is part of completing the
   action, not bookkeeping that happens afterward.
5. Repeat 2–4 for the step's remaining actions.
6. When all of the step's actions are checked, check the step header's
   own box, then return to 1.
7. When every step header is checked, run `## Final Verification`: execute
   each check in order, tick its box **immediately** after the check passes.
   A failing check is a regression: find the step that introduced it, fix
   there, log `[deviation]:`, then re-run the check.

### Editing the plan file
The plan changes on every tick, so keep every edit to the smallest safe unit.
- **Tick a box** — a single-line `edit` where `oldText` is exactly the
  current line. Read the plan before the first tick of a step; subsequent
  ticks in that step reuse the known text (your own ticks only changed lines
  you ticked).
- **Add an implementation note** — the line below the checkbox (indented
  plain lines); do not reformat or re-wrap surrounding lines.
- **Paste baseline output** — only into its own `Output:` placeholder line;
  never re-wrap or edit neighboring lines.
- **Never span other lines** in an edit's `oldText` — checkbox lines change
  with every tick, which makes multi-line blocks stale.

### Discipline
- **Unattended by default** — do not ask clarifying questions.
  - Ambiguity with several valid paths → pick the best, log
    `[assumption]: ...` on the action's note line, and continue.
  - No valid path (missing prerequisite, breakage that blocks later steps,
    or a dependency the plan doesn't list) → log `[blocker]:` there,
    continue independent actions, then stop. Do not improvise around it.
  - Every `[assumption]`/`[blocker]` entry must survive the run and be
    findable in a post-session review — the trail must be visible.
- **Notes** — implementation details go on the line below the ticked
  action; prefix choices and departures from the plan with
  `[assumption]:` / `[deviation]:` so the trail stays findable after the
  session.
