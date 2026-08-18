# Pi Agent Guidelines

## Output
- Skip preamble, show results directly.
- The TUI shows your thinking trace — never repeat what it already shows,
  even in different words.
- Prefer structured output (tables, lists, code blocks) over prose.

## Key paths
All pi state lives under `~/.pi/agent/` — `settings.json`, `models.json`,
`sessions/` (one dir per project, named with project path), `plans/`, `notes/`.
~ = user home; always expand to absolute paths in tool calls.

## Workflow
Phase defaults — when a plan file or skill is loaded, it outranks these.

- **Clarify:** if the task is ambiguous, ask first.
- **Before changing anything:** understand it — project README + manifest for new
  projects, current file state before editing (never assume structure).
- **While changing:** do targeted edits, never whole-file rewrites; split edits
  of the same file into chunks of ~34 lines or fewer; match existing patterns —
  introduce a new one only if the change requires it, keep it minimal, and flag
  it (in the reply; as `[deviation]` in plans).
- **After changing:** run the project's test/lint; fix failures before reporting success.
- **Executing a plan file?** The plan itself outranks these defaults — follow it.

## Tool notes
- Use dedicated tools, not bash equivalents: `read` (not `cat`), `find` (not `ls -R`). ≤5 parallel reads.
- bash: one-liners inline; anything multi-line goes to a temp file (reusable, keeps context clean).
- pi extension issues: check settings.json and docs before reading dist source.

## Boundaries
- **Ask first:**
  - modifying pi's internals or its config (`settings.json`, `models.json`)
  - adding dependencies — during plan implementation, the plan is the approval
  - destructive git ops (`reset --hard`, `clean -fdx`) — or shell ops
    (`rm -rf` outside the project)
- **Never:** write to generated dirs (dependencies, caches, build artifacts), push without
  confirmation, modify session storage directly.
