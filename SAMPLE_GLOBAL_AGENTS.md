# Pi Agent Guidelines

- The TUI displays thinking traces. Skip preamble, show results directly — never restate what was already in your thinking trace.
- Responds well to explicit constraints over implicit ones. If a rule is being ignored, re-state it rather than assuming it was forgotten.
- Prefer structured output (tables, lists, code blocks) over prose paragraphs. Dense text consumes more visible context in the TUI.

## Key Paths
| What | Path |
|------|------|
| This file | `~/.pi/agent/AGENTS.md` |
| Pi settings | `~/.pi/settings.json` |
| Models config | `~/.pi/agent/models.json` |
| Session storage | `~/.pi/agent/sessions/` (one dir per project, named with project path) |

## Work Patterns

### Explore first
1. Read README + project manifest before `find` or `ls -R`.
2. List files then read (not cat). Max 5 `read` calls per batch when independent.
3. Use `find` to list relevant source files, not `ls -R`.

### Plan for scope
If a change modifies 4+ files or touches core architecture, state the plan in your response before coding. Skip planning for obvious fixes (typo, rename).

### Implement iteratively
1. Read the relevant file(s) first — never assume structure.
2. One edit per file unless changes are tightly related.
3. Match existing patterns — don't introduce new ones without justification.

### Verify always
1. Run the project's build/lint/check commands after code changes.
2. Fix failures before reporting success. The agent should close its own verification loop.

### Trust tool orchestration
Designed to call tools, browse codebases, and iterate. Trust it to call bash/read/edit rather than second-guessing each individual command.

### When a tool fails
- Check exit code: `143` = killed (SIGTERM), `130` = interrupted (Ctrl+C).
- For pi extension issues: check `~/.pi/settings.json` and docs **before** reading dist source files.

## Tool Conventions

- **bash**: Keep commands short. Write scripts larger than one-liners to a temp file (reusable, doesn't bloat context).
- **read**: Use with `offset`/`limit` for large files (>500 lines).
- **edit**: Provide exact matching text; prefer small, targeted replacements over large blocks.

## Working Boundaries

### ⚠️ Ask first
- Modifying pi internals, adding dependencies, or changing config files

### 🚫 Never
- Write to auto-generated directories (dependencies, caches, build artifacts)
- Commit/push without user confirmation
- Modify session storage directly

## Bundled Tool Repair

Tool-call repair is active by default (bundled from @r3b1s/pi-repair-layer).
- View stats: `/repair-stats`
- Configure: `/repair-settings`

## Bundled Skills

### Deep Research (`/skill:deep-research`)

Multi-step autonomous research workflow. Guides planning, iterative retrieval, cross-source validation, and structured report generation with full citations. Use for complex research questions, competitive analysis, literature reviews, and trend mapping.