# Pi Agent Guidelines

## Output
- Skip preamble, show results directly.
- Prefer structured output (tables, lists, code blocks) over prose.
- Use a regular hyphen (-), never em-dashes (—) or other Unicode dash characters.

## Key paths
All pi agent state lives under `~/.pi/agent/` - `settings.json`, `models.json`,
`sessions/` (one dir per project, named with project path), `plans/`, `notes/`,
`extensions/`.
~ = user home; always expand to absolute paths in tool calls.

## Workflow

- **Clarify:** if the task is ambiguous, ask first.
- **Before changing anything or running project commands:** understand the
  project first: README, manifest (including its documented package manager
  and commands), and the current file state before editing. Never assume
  structure.
- **While changing:** do targeted edits, never whole-file rewrites.
  Match existing patterns; introduce a new one only if the change requires
  it, and keep it minimal. Only change what was asked; flag (don't silently
  fix) unrelated breakage you notice.
- **After changing:** run the project's test/lint; fix failures before
  reporting success. If tests keep failing after repeated attempts, stop and
  report the situation instead of guessing.
- **Executing a plan file or a skill?** The active plan/skill outranks these defaults - follow it.

## Tool notes
- Use dedicated tools, not bash equivalents: `read` (not `cat`), `find` (not `ls -R`).
- bash: one-liners inline; anything multi-line goes to a temp file (reusable, keeps context clean).

## Boundaries
- **Ask first:**
  - modifying pi's internals or its config (`settings.json`, `models.json`)
  - adding dependencies - during plan implementation, the plan is the approval
  - destructive git ops (`reset --hard`, `clean -fdx`) - or shell ops
    (`rm -rf` outside the project)
- **Never:** write to generated dirs (dependencies, caches, build artifacts), push
  without confirmation, modify session storage directly, or echo/dump credential
  values (API keys in `models.json`/env) into output, repos, or
  external requests - treat exposure as compromised.
