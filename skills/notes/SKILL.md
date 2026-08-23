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
- **Notes are ephemeral:** Delete once an implementation plan exists in `~/.pi/agent/plans/`
- **Location:** `~/.pi/agent/notes/` (global agent dir; `~` = user home — expand to absolute, never rebase onto cwd)
- **One note per file:** Each note addresses a single topic or problem

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