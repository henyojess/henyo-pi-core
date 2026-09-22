## How to Use This Plan

> **Execution Discipline — read before starting.**
> Mark each checkbox **immediately after completing that sub-step**, not at the end. Do not batch-mark. Each `[x]` is a record, not a pre-commitment. One sub-step at a time — discipline over momentum.

## Before You Start

Read this entire plan. Then state how you will work with it.

If this plan was spawned by a note in `~/.pi/agent/notes/` (see Source Note
Inheritance), do this before Step 1:
1. Re-read the source note file — do not rely on memory of its content.
2. Verify every Source Note Inheritance row maps to a plan location.
3. Delete the source note `~/.pi/agent/notes/<source>.md`. The plan is now
   the sole record.

If this plan contains a Baseline Pre-Check section, execute it before Step 1:
run each command, paste results verbatim into the placeholders, and mark the
checkboxes. No Step 1 work happens until the baseline is recorded.

### Execution Loop (per sub-step)
1. Find the first unchecked `[ ]` sub-step in the current step.
2. Do the work described in that sub-step.
3. **Immediately** mark it `[x]` in the plan file, adding implementation notes — prefix
   assumptions and deviations with `[assumption]:` / `[deviation]:`.
   The tick is part of completing the sub-step, not bookkeeping that happens afterward.
4. Move to the next `[ ]` sub-step.
5. When all sub-steps in a step are `[x]`, mark the step header's own checkbox `[x]`.

### Updating this plan (checkbox surgery)
- Tick = a single-line edit: `oldText` is exactly the current line. Read the plan
  before the first tick of a step; subsequent ticks in that step reuse the known
  text (your own ticks only changed lines you ticked). Never span other lines —
  they change with every tick.
- Paste baseline output only into its own `Output:` placeholder line; never
  re-wrap or edit neighboring lines.
- Implementation notes go on the line below the checkbox (indented plain lines);
  do not reformat or re-wrap surrounding lines.

### Discipline
- Mark each checkbox **right after completing that sub-step**, not at the end of the step.
  - If the session is interrupted, the plan file reflects actual progress and work can resume without re-doing anything.
- Add implementation details alongside the marked sub-step. Prefix assumptions and
  deviations with `[assumption]:` / `[deviation]:` so they stay greppable after an
  unattended run.
  - This preserves context for anyone (or any session) that picks up the work later.
- Implementing this plan is unattended by default: do not ask clarifying questions.
  - Recoverable ambiguity (many valid paths) → choose the best option, log it as
    `[assumption]: ...` next to the sub-step, and continue.
  - True blocker (no valid path: missing prerequisite, breakage that blocks later
    steps) → log `[blocker]:` there, continue with independent sub-steps, then stop.
    Do not improvise around it.
  - Every `[assumption]`/`[blocker]` is a morning-review item — the trail must be visible.
- Dependencies: add only what the plan lists. A needed dependency that the plan
  doesn't list is a `[blocker]` — log it and continue independent work.
- Do not batch-mark checkboxes. Each `[x]` is a record, not a pre-commitment.
  - Batching creates false progress — you haven't actually verified the work is done.
- One sub-step at a time. It is better to do one correctly than five poorly.
  - Doing five poorly means five things to fix. Doing one correctly means one thing done.
- Checkbox updates: use a **single-line** `edit`, where `oldText` is exactly the
  current line (from a fresh read). Never include other checkbox lines in
  `oldText` — they change with every tick, which makes multi-line blocks stale.
