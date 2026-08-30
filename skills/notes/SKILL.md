---
name: notes
description: Use when capturing transient information that doesn't belong in code or documentation yet. Manage ephemeral working notes for tracking context, decisions, and next steps during development. Notes are stored in ~/.pi/agent/notes/ and deleted once a plan exists.
---

# Notes Workflow

A structured approach for creating ephemeral working notes during development sessions. Notes capture context, decisions, and next steps — they are not permanent artifacts.

## Note Format

Every note file follows this structure:

```markdown
# Title

**Status:** Open / In Progress / Completed / Superseded
**Date:** YYYY-MM-DD (from `date +%F` — see Rules)

## Goal
What problem or question is this note trying to address?

## Context
Background information, relevant details, constraints.

## Notes
Key observations, findings, or decisions. Use lists and tables.

## Next Steps
- [ ] Action item 1
- [ ] Action item 2
```

## Rules

- **Dates are checked, never guessed:** the current date is NOT in your context — model-recalled dates are fabricated. Run `date +%F` and use its output for the `**Date:**` field (and any other date you write in the note).
- **Lowercase-slug filenames:** e.g., `fix-auth-timeout.md`, not `Fix Auth Timeout.md`
- **Notes are ephemeral:** Delete once an implementation plan exists in `~/.pi/agent/plans/` — the plan is the record
  - **Note spawned the plan:** the plan's Final Verification carries the delete item (plan-generation skill, source-note rule); the executor removes the note at plan completion.
  - **Plan already exists (discovered later):** delete the note now.
  - **Conflict rule:** if a plan instructs *updating* a note (e.g., status → Planned) instead of deleting it, log `[deviation]: plan says update note; notes skill mandates delete` next to that step and still delete the note at plan completion.
- **Location:** `~/.pi/agent/notes/` (global agent dir; `~` = user home — expand to absolute, never rebase onto cwd)
- **One note per file:** Each note addresses a single topic or problem
- **Handoff path:** when you create a note, the reply must end with one line
  per note created — the note's full absolute path (`~` expanded to the home path),
  after the summary — so the user can copy the exact file to hand a new session.
  - The line is bare — no labels, no prose, no backticks.
  - Multiple files in one reply → notes first, then plans.

## When to Use This Skill

- Capturing transient information during exploration
- Tracking decisions that may need revisiting
- Recording blockers or questions for later
- Documenting context before a plan is written

## When NOT to Use This Skill

- Information that belongs in code comments
- Permanent documentation (use README or inline docs)
- Implementation plans (use the plan-generation skill)
- Session context (use session storage)