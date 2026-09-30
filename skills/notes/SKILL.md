---
name: notes
description: Captures transient working notes - context, findings, decisions, blockers, and next steps that don't belong in code or docs yet. Use when the user asks to write down, remember, or keep track of something, or when exploration surfaces information to record for later. Stored in ~/.pi/agent/notes/ as one lowercase-slug file per topic. Not for work with a defined execution goal.
---

# Notes Workflow

A structured approach for creating ephemeral working notes during development sessions. Notes capture context, decisions, and next steps — they are not permanent artifacts.

## Note Format

Every note file follows this structure:

```markdown
# Title

**Status:** Open / In Progress / Completed
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
- **Notes are ephemeral:** the only deletion path is when the note spawns a plan — delete it at plan generation, once the plan's Source Note Inheritance section maps every note finding/decision/next step into a plan location and the mapping is verified exhaustive against the note (re-read the note; every item needs a row). From that point the plan is the sole record — nothing may be lost.

- **Location:** `~/.pi/agent/notes/` (global agent dir; `~` = user home — expand to absolute, never rebase onto cwd)
- **One note per file:** Each note addresses a single topic or problem
- **Handoff path:** when you create a note, the reply includes one line per note
  created — the note's full absolute path (`~` expanded to the home path), after the
  summary — so the user can copy the exact file to hand a new session.
  - The line is bare — no labels, no prose, no backticks.
  - Multiple files in one reply → note lines first, then the plan path (the plan
    path is the last line).

## When to Use This Skill

- Capturing transient information during exploration
- Tracking decisions that may need revisiting
- Recording blockers or questions for later
- Documenting context before a plan is written

## When NOT to Use This Skill

- Information that belongs in code comments
- Permanent documentation (use README or inline docs)
- Implementation plans (use the plans skill)
- Session context (use session storage)