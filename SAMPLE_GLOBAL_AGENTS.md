# Pi Agent Guidelines

- The TUI displays thinking traces. Skip preamble, show results directly — never restate what was already in your thinking trace.
- State rules explicitly rather than implying them. If a rule is being ignored, re-state it rather than assuming it was forgotten.
- In interactive mode, ask clarifying questions before proceeding. When asked to implement a plan, document your assumptions.
- Prefer structured output (tables, lists, code blocks) over prose paragraphs. Dense text consumes more visible context in the TUI.

## Key Paths
| What | Path |
|------|------|
| This file | `~/.pi/agent/AGENTS.md` |
| Pi settings | `~/.pi/agent/settings.json` |
| Models config | `~/.pi/agent/models.json` |
| Session storage | `~/.pi/agent/sessions/` (one dir per project, named with project path) |
| Plan storage | `~/.pi/agent/plans` |

## Work Patterns

### Explore first
1. Read README + project manifest before exploring the codebase.
2. Use the `read` tool (not `cat` via bash). Limit to 5 parallel `read` calls for different files.
3. Use `find` to list relevant source files, not `ls -R`.

### Plan for scope
If a change modifies 4+ files or touches core architecture, state the plan in your response before creating or modifying files. Skip planning for obvious fixes (typo, rename).

### Follow plans diligently
When executing a plan file (e.g., `~/.pi/agent/plans/*.md`):
1. Mark each sub-step `[x]` **immediately after completing it**, not at the end of the step.
2. Add implementation details, deviations from the plan, and assumptions alongside the marked sub-step.
3. Do not batch-mark checkboxes — each `[x]` is a record of completed work, not a pre-commitment.
4. The plan file is a living execution log, not a static reference document.

### Implement iteratively
1. Read the relevant file(s) first — never assume structure.
2. Split large edits (>55 lines) into smaller, logical changes.
3. Match existing patterns — don't introduce new ones without justification.
4. Call tools freely — don't second-guess each individual command.

### Verify always
1. Run the project's test/lint/check commands after code changes.
2. Fix failures before reporting success. The agent should close its own verification loop.

### When a tool fails
- Check exit code: `143` = killed (SIGTERM), `130` = interrupted (Ctrl+C).
- For pi extension issues: check `~/.pi/agent/settings.json` and docs **before** reading dist source files.

## Tool Conventions

- **bash**: Keep commands short. Write scripts larger than one-liners to a temp file (reusable, doesn't bloat context).
- **read**: Use with `offset`/`limit` for large files (>500 lines).
- **edit**: Provide exact matching text; prefer small, targeted replacements. Split edits >55 lines into logical chunks.

## Working Boundaries

### ⚠️ Ask first
- Modifying pi internals, adding dependencies, or changing config files

### 🚫 Never
- Write to auto-generated directories (dependencies, caches, build artifacts)
- Push without user confirmation
- Modify session storage directly

