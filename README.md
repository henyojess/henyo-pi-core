# henyo-pi-core

Pi coding agent extensions for long-horizon agentic SWE using local models.

## Installation

On first load, the extension seeds `~/.pi/agent/AGENTS.md` — it copies `SAMPLE_GLOBAL_AGENTS.md` to your pi config directory if the file doesn't already exist, providing default guidelines for new users.

## Structure

```
henyo-pi-core/
├── package.json          # Extension manifest with pi entry point
├── .gitignore
├── LICENSE               # MIT License
├── pnpm-workspace.yaml   # pnpm workspace root (allowBuilds)
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
│   ├── henyo-settings.ts # henyo settings block: types, defaults, merge, effective-state reader
│   ├── ttft-tokps.ts     # Working line: TTFT + live/exact tok/s display (config-gated)
│   ├── footer.ts         # Compact footer: name•model(level)•ctx%•path(branch)
│   ├── settings-io.ts    # Shared settings.json path + read helper (tolerates missing/invalid file)
│   ├── edit-path-repair.ts # Standalone edit path fix (event hooks: repair, coaching, prompt guideline)
│   └── commands/         # Custom slash commands
│       ├── cwd.ts        # /cwd: switch project directory (new session in target dir)
│       ├── newp.ts       # /newp: start a new session with an initial prompt
│       └── henyo.ts      # /henyo: list or toggle all henyo features
└── test/
    ├── footer.test.ts    # Unit tests for footer layout and status line
    ├── edit-path-repair.test.ts # Tests for the standalone edit path fix
    ├── index.test.ts     # Entry-point tests: settings fill-write, footer attach, re-render
    ├── load-henyo-settings.test.ts # henyo settings block: merge, fill writes, steady state
    ├── ttft-tokps.test.ts          # Working line: v2 harness scenarios + trace on/off/rotation/contract
    ├── commands/         # Unit tests for command handlers
    │   ├── cwd.test.ts
    │   ├── henyo.test.ts
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

### `/henyo [key [value]]`

List or toggle all henyo features from the TUI — the replacement for
hand-editing `settings.json`:
- With no args: opens a picker of all 9 keys labeled `key: on` / `key: off`
  (state from the effective merged settings); pick one to toggle it.
- `/henyo <key>` flips the key's current effective state.
- `/henyo <key> <value>` sets the key explicitly; values are
  `on off true false enable disable` (case-insensitive).
- Keys are given in canonical form (`editPathFix`, `footer`, `agentsMd`,
  `ttftTokps`, `trace`, `skills.notes`, `commands.cwd`) or, for the dotted
  keys, in their flat shorthand (`notes`, `plan-generation`, `cwd`, `newp`)
  (`ttftTokps`/`trace` are top-level — no shorthand). Tab-completion is
  offered for both keys and values.
- `footer` applies live in the current session; all other keys are written
  and applied after an automatic extension reload (same semantics as
  `/reload` — the success toast says `— reloading`).
- `/henyo` is always available — it is intentionally not one of the
  `commands.*` settings keys, so it can never be gated behind a setting
  that would need it to re-enable itself.
- Non-TUI mode (`hasUI: false`): toggles via explicit args still work
  (write + reload); the bare picker form is a no-op.

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

### Working Line (TTFT + tok/s)

While generating, the `Working...` line shows time to first token (TTFT), a
live tok/s rate, and the token span, e.g.
`Working... TTFT 1.00s · ≈34.00 tok/s · 44 tok/1.19s`:

- **Live rate** — estimated tokens (delta character count ÷ learned
  per-model chars-per-token ratio) ÷ elapsed seconds. When the provider
  reports `usage.output` mid-stream the rate becomes exact (same `≈` readout,
  usage-based); at `message_end` the line ends with a final readout
  (`· NN.NN tok/s (final)`), computed from usage when a token span is
  available, otherwise from the last delta time
- **Stall handling** — no delta of any kind for 1.5 s → the line holds its
  last readout and appends `…`; generation resuming or the message ending
  restores the normal readout
- **Final hold** — the final readout is held for 5 s before the default
  `Working...` line is restored; a new LLM call cancels the hold and takes
  over the line
- **Calibration** — per-model chars-per-token ratios (think/text/tool)
  are learned online (EMA on in-range samples) and persisted to
  `~/.pi/agent/extensions/.ttft-tokps-state.json`; a neutral bias
  (clamped [0.5, 2.0]) further corrects the estimate against exact usage,
  keyed per model in the same file

Gated by `ttftTokps` (default `true`).

**Trace file:** with `trace: true`, every display decision is appended as
JSONL to `/tmp/ttft-debug.log` — each line carries
the event payload **and** the exact working message that was displayed, so
live-vs-final estimate error is auditable straight from the log. Writes are
size-rotated (`.1`, `.2`, `.3` backups by default — 10 MiB cap, 3 backups)
and silent on failure (a broken log never breaks the TUI). Off by default —
enable it via `/henyo trace on` to investigate rate discrepancies.

**Legacy note:** the original standalone `~/.pi/agent/extensions/ttft-tokps.ts`
pre-dates this port. After the live `/reload` verification (plan step 7.3)
it will be deleted; until then disable it there (or delete it) so the two
don't render the working line twice.

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
| `ttftTokps` | `boolean` | `true` | Working line with TTFT + tok/s (live estimate, exact when usage is reported, final readout) |
| `trace` | `boolean` | `false` | JSONL trace of every ttftTokps display decision (incl. the exact displayed string), size-rotated |
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

Toggling individual features from the TUI is covered by `/henyo` (see
Registered Commands) — it is intentionally absent from the `commands.*`
keys. Stale entries left under `commands` in an existing `settings.json`
for a retired command (the old footer toggle) are inert: unknown keys are
preserved on settings writes and ignored by the extension.

### Example Configuration

```json
{
  "henyo": {
    "editPathFix": true,
    "footer": true,
    "agentsMd": true,
    "ttftTokps": true,
    "trace": false,
    "skills": {
      "plan-generation": true,
      "notes": false
    },
    "commands": {
      "cwd": true,
      "newp": false
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
    "ttftTokps": false,
    "trace": false,
    "skills": {
      "plan-generation": false,
      "notes": false
    },
    "commands": {
      "cwd": false,
      "newp": false
    }
  }
}
```

**Note:** When the `henyo` block is absent from `settings.json`, all features remain enabled (default behavior unchanged).

## Development

### Prerequisites

- Node.js 22+
- pnpm — activated via corepack: `corepack enable pnpm` (if the default install dir is read-only, target a writable PATH dir: `corepack enable pnpm --install-directory ~/.local/bin`)
- Globally installed [Pi coding agent](https://pi.dev) (`npm install -g @earendil-works/pi-coding-agent`)

### Available Scripts

```bash
pnpm dev                    # Run pi with this extension loaded (pi -e ./index.ts)
pnpm test                   # Run Vitest unit tests
pnpm run lint               # Type-check (tsc) + ESLint style checks
pnpm run lint:fix           # Auto-fix ESLint issues
pnpm run format             # Check Prettier formatting
pnpm run format:fix         # Auto-format with Prettier
pnpm run build              # TypeScript type-check build
pnpm run test:coverage      # Run tests with coverage report (80% thresholds)
```

### Architecture

The extension follows a factory pattern — `src/index.ts` exports a default function that receives the Pi `ExtensionAPI` and registers all commands, tools, and event handlers. This function is invoked by pi when loading the extension.

**Command registration:** Each command lives in its own file under `src/commands/`, exporting a function that accepts the API instance and calls `pi.registerCommand()`.

**Session management:** The `/cwd` command creates a minimal session file (`.jsonl`) in the target's session directory with the CWD in its header, then calls `ctx.switchSession()`. The file is deleted in `withSession` so empty sessions don't pollute `/resume` — pi persists to the correct location when the user sends their first message.

### Testing

Tests use Vitest with mocked pi-coding-agent internals. Each test file covers its corresponding command handler, including edge cases for error conditions and cancellation scenarios. Coverage thresholds are set at 80%.

## API Reference

See [Pi Extensions Docs](https://pi.dev/docs/extensions) for the extension API reference.