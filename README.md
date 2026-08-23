# henyo-pi-core

Pi coding agent extensions for long-horizon agentic SWE using local models.

## Installation

On first load, the extension seeds `~/.pi/agent/AGENTS.md` — it copies `SAMPLE_GLOBAL_AGENTS.md` to your pi config directory if the file doesn't already exist, providing default guidelines for new users.

## Structure

```
henyo-pi-core/
├── package.json          # Extension manifest with pi entry point
├── .gitignore
├── README.md
├── SAMPLE_GLOBAL_AGENTS.md  # Default AGENTS.md template (seeded on first load)
├── eslint.config.mjs     # ESLint flat config (style rules + Prettier integration)
├── .prettierrc.json      # Prettier configuration
├── .prettierignore       # Files to exclude from formatting
├── tsconfig.json         # TypeScript compiler options
├── vitest.config.ts      # Vitest test runner config
├── index.ts              # Re-export for pi extension loading
├── skills/               # Bundled pi skills
│   ├── plan-generation/  # Structured plan generation for multi-step tasks
│   └── notes/            # Ephemeral working notes for tracking context and decisions
├── src/
│   ├── index.ts          # Extension factory (registers commands, tools, events)
│   ├── footer.ts         # Compact footer: name•model(level)•ctx%•path(branch)
│   ├── settings-io.ts    # Shared settings.json path + read helper (tolerates missing/invalid file)
│   ├── edit-path-repair.ts # Standalone edit path fix (event hooks: repair, coaching, prompt guideline)
│   └── commands/         # Custom slash commands
│       ├── cwd.ts        # /cwd: switch project directory (new session in target dir)
│       ├── newp.ts       # /newp: start a new session with an initial prompt
│       └── henyo-footer.ts # /henyo_footer: live-toggle the custom footer
└── test/
    ├── footer.test.ts    # Unit tests for footer layout and status line
    ├── edit-path-repair.test.ts # Tests for the standalone edit path fix
    ├── commands/         # Unit tests for command handlers
    │   ├── cwd.test.ts
    │   ├── henyo-footer.test.ts
    │   └── newp.test.ts
```

## Custom Footer

A compact footer renders one packed line:
```
myproj•qwen3.8-27b(xhi)•42%/84k•/~/pi/proj(main)
```

- Session name (bright) is prepended as `name•` only when the session has a name; it is never truncated
- Model segment is `model` plus a 3-char thinking-level suffix `(xhi)` / `(low)` / … only for reasoning models at a level other than `off`
- Context usage is `NN%/usedk`, or `?/windowk` when unknown; color-coded: yellow 50–80%, red ≥81%
- Path is shown from the right as space allows — last segment bright, prefix dim — with the git branch glued in parens: `path(branch)`
- All segments are joined by `•` (no spaces); non-bright content is dimmed
- Truncation: when space is tight, the path and branch are truncated from the right while the left block (name • model • context) stays intact
- Extension statuses appear on a second line (dim, keys sorted) only when an extension registers them — the footer is one line by default

## Registered Commands

### `/cwd [path]`

Switch to another project directory and start a new session in the target dir.
- With no args: shows the current working directory.
- With a path argument: creates a session file in the target's session directory with the correct CWD in its header, then switches to it. The file is deleted after switching so empty sessions don't pollute `/resume` — pi persists to the correct location on the user's first message.

### `/newp <prompt>`

Start a new session with an initial prompt. The prompt is sent as the first
user message in the new session.

### `/henyo_footer`

Toggle the compact footer on/off. Persists to `henyo.footer` in
`~/.pi/agent/settings.json` and applies immediately in the current session.
Shows the new state via a TUI notification (`Henyo footer enabled` /
`Henyo footer disabled`). Arguments are ignored (toggle only).

## Bundled Skills

### `/skill:plan-generation`

A structured methodology for producing plans that an agent can execute without human clarification. Every plan is a checklist: read, check off steps, commit, verify. Produces plans with measurable acceptance criteria, scope boundaries, dependency ordering, and per-step verification. Use whenever a plan is requested or when a task involves multiple steps, file changes, or dependencies.

**Workflow:** Plan → Execute → Verify

### `/skill:notes`

A structured approach for creating ephemeral working notes during development sessions. Notes capture context, decisions, and next steps — they are not permanent artifacts. Notes are stored in `~/.pi/agent/notes/` and deleted once an implementation plan exists.

**When to use:** Capturing transient information, tracking decisions, recording blockers, documenting context before a plan is written.

## Bundled Extensions

### Edit Path Fix

Some models (observed: Qwen 3.6) emit the `edit` tool's `path` argument
nested inside `edits[0]` instead of at the top level, so the call fails
validation. henyo-pi-core fixes this with three event hooks — no tool
overrides, so it coexists with other repair layers:

- **Repair** — a `message_end` hook rewrites the assistant message's `edit`
  calls before execution: `edits[0].path` is hoisted to the top-level `path`
  and removed from the edit objects.
  History side effect: repaired calls appear in the session history in
  corrected form, not in their original shape.
- **Validation coaching** — when an `edit` call still fails argument
  validation, a one-line hint is appended to the error the model sees:
  "`path` goes at the top level, next to `edits`".
- **Prompt guideline** — one line is appended to the system prompt so models
  emit the correct shape up front (idempotent — skipped when already present).

Active by default; no configuration needed.

**Log file:** fixes and validation failures are appended as JSONL to
`~/.pi/agent/edit-path-repair.jsonl` (healthy no-ops are not logged).
Record shape: `{ ts, tool, model, outcome, rules?, issues?, fingerprint }`
— `outcome` is `fixed` (hoist applied) or `failed` (validation actually
failed; `issues` carries a shape diagnostic). Argument values are never
logged.

```bash
jq -r .outcome ~/.pi/agent/edit-path-repair.jsonl | sort | uniq -c
```

## Settings

All henyo-pi-core features can be individually enabled or disabled via a `henyo` block in `~/.pi/agent/settings.json`. The block is created automatically on first install and extended when the extension adds new features — only *missing* keys are added (with their defaults); keys you have set are never modified. Absent or unknown keys behave as enabled, so a partial block is always safe.

### Feature Toggles

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `editPathFix` | `boolean` | `true` | Edit path fix + coaching + prompt guideline (legacy key `toolRepair` honored when `editPathFix` is unset) |
| `footer` | `boolean` | `true` | Render compact footer (`name•model(level)•ctx%•path(branch)` + conditional status line) |
| `agentsMd` | `boolean` | `true` | Copy `SAMPLE_GLOBAL_AGENTS.md` to `~/.pi/agent/AGENTS.md` on first install |
| `skills.<name>` | `boolean` | `true` | Enable/disable individual bundled skills |
| `commands.<name>` | `boolean` | `true` | Enable/disable individual custom commands |

### Nested Keys

**Skills:**

| Key | Default | Description |
|-----|---------|-------------|
| `plan-generation` | `true` | Structured plan generation for multi-step tasks |
| `notes` | `true` | Ephemeral working notes for tracking context and decisions |

**Commands:**

| Key | Default | Description |
|-----|---------|-------------|
| `cwd` | `true` | `/cwd` — switch project directory |
| `newp` | `true` | `/newp` — start a new session with an initial prompt |
| `henyo_footer` | `true` | `/henyo_footer` — live-toggle the custom footer |

### Example Configuration

```json
{
  "henyo": {
    "editPathFix": true,
    "footer": true,
    "agentsMd": true,
    "skills": {
      "plan-generation": true,
      "notes": false
    },
    "commands": {
      "cwd": true,
      "newp": false,
      "henyo_footer": true
    }
  }
}
```

To disable only the notes skill:

```json
{
  "henyo": {
    "skills": {
      "notes": false
    }
  }
}
```

To disable all henyo features:

```json
{
  "henyo": {
    "editPathFix": false,
    "footer": false,
    "agentsMd": false,
    "skills": {
      "plan-generation": false,
      "notes": false
    },
    "commands": {
      "cwd": false,
      "newp": false,
      "henyo_footer": false
    }
  }
}
```

**Note:** When the `henyo` block is absent from `settings.json`, all features remain enabled (default behavior unchanged).

## Development

### Prerequisites

- Node.js 22+
- Globally installed [Pi coding agent](https://pi.dev) (`npm install -g @earendil-works/pi-coding-agent`)

### Available Scripts

```bash
npm test                   # Run Vitest unit tests
npm run lint               # Type-check (tsc) + ESLint style checks
npm run lint:fix           # Auto-fix ESLint issues
npm run format             # Check Prettier formatting
npm run format:fix         # Auto-format with Prettier
npm run build              # TypeScript type-check build
npm test -- --coverage     # Run tests with coverage report (80% thresholds)
```

### Architecture

The extension follows a factory pattern — `src/index.ts` exports a default function that receives the Pi `ExtensionAPI` and registers all commands, tools, and event handlers. This function is invoked by pi when loading the extension.

**Command registration:** Each command lives in its own file under `src/commands/`, exporting a function that accepts the API instance and calls `pi.registerCommand()`.

**Session management:** The `/cwd` command creates a minimal session file (`.jsonl`) in the target's session directory with the CWD in its header, then calls `ctx.switchSession()`. The file is deleted in `withSession` so empty sessions don't pollute `/resume` — pi persists to the correct location when the user sends their first message.

### Testing

Tests use Vitest with mocked pi-coding-agent internals. Each test file covers its corresponding command handler, including edge cases for error conditions and cancellation scenarios. Coverage thresholds are set at 80%.

## API Reference

See [Pi Extensions Docs](https://pi.dev/docs/extensions) for the extension API reference.