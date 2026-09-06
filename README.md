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
│   ├── tool-repair.ts    # Standalone tool repair (event hooks: repair, coaching, prompt guideline)
│   ├── edit-fallback.ts  # Fuzzy/nearest-match edit fallback: pure matching + report core (no pi imports)
│   ├── compaction-retry.ts # Compaction summary retry guard: strict plain-text prompt, up to 3 targeted retries
│   └── commands/         # Custom slash commands
│       ├── cwd.ts        # /cwd: switch project directory (new session in target dir)
│       ├── newp.ts       # /newp: start a new session with an initial prompt
│       └── henyo.ts      # /henyo: list or toggle all henyo features
└── test/
    ├── footer.test.ts    # Unit tests for footer layout and status line
    ├── tool-repair.test.ts    # Tests for the standalone tool repair
    ├── tool-repair-edit-fallback.test.ts # Hook wiring: rewrite, pending telemetry, coaching, guards
    ├── edit-fallback.test.ts # Unit tests for the pure matching/candidate/duplicate core
    ├── index.test.ts     # Entry-point tests: settings fill-write, footer attach, re-render
    ├── load-henyo-settings.test.ts # henyo settings block: merge, fill writes, steady state
    ├── ttft-tokps.test.ts          # Working line: v2 harness scenarios + trace on/off/rotation/contract
    ├── compaction-retry.test.ts    # Compaction retry guard: success, 4 failure retries, exhaustion, abort, no-ops, contract
    ├── fixtures/         # Test fixtures (recorded model failure payloads)
    │   └── edit-failure-payloads.json
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
- Model segment is `model` plus a thinking-level suffix for reasoning models: a 3-char level (`(low)` / `(med)` / `(xhi)`) when the model's compat declares `supportsReasoningEffort`, else `(on)` / `(off)`; no suffix for non-reasoning models
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
- With no args: opens a picker of all 11 keys labeled `key: on` / `key: off`
  (state from the effective merged settings); pick one to toggle it.
- `/henyo <key>` flips the key's current effective state.
- `/henyo <key> <value>` sets the key explicitly; values are
  `on off true false enable disable` (case-insensitive).
- Keys are given in canonical form (`toolRepair`, `footer`, `agentsMd`,
  `ttftTokps`, `trace`, `compactionRetry`, `skills.notes`, `commands.cwd`) or, for the dotted
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

### Tool repair

Some models (observed: Qwen 3.6) emit broken `edit` arguments: `path`
nested inside `edits[0]` instead of the top level, the whole `edits`
array stringified as JSON, `edits` truncated mid-JSON, or entries missing
keys — the call fails validation. henyo-pi-core repairs these and coaches
on any tool's schema failures, with three event hooks — no tool overrides,
so it coexists with other repair layers:

- **Repair** — a `message_end` hook rewrites the assistant message's `edit`
  calls before execution, applying up to five rules in order: a stringified
  `edits` value (`"edits": "[...]"`) is parsed back into an array
  (`parse-stringified-edits`); `edits[0].path` is hoisted to the top-level
  `path` and removed from the edit objects (`extract-path`); `edits` strings
  that fail strict parsing are salvaged — cut where the model degenerated
  into its next emission, raw control chars escaped, missing string/array
  closers appended — only when a root `path` exists and the result has a
  complete `oldText`/`newText` entry (`salvage-corrupt-edits`); a garbled
  `path` key nested inside an entry (e.g. `path>`) is moved to the top
  level and deleted from the entries (`recover-garbled-path`); and entries
  missing a string `oldText` or `newText` are dropped when at least one
  entry is complete (`drop-incomplete-edits`). Several rules can fire on
  one call and the fix is logged with the rules that fired.
  History side effect: repaired calls appear in the session history in
  corrected form, not in their original shape.
- **Edit fallback** — a second `message_end` stage for `edit` calls that
  survived the shape rules but would still fail on whitespace drift:
  when the built-in exact match would fail (the `oldText` is absent from
  the file), the fallback looks for the one region whose
  whitespace-normalized lines match the `oldText` exactly (1:1, unique).
  On a unique match the `oldText` is rewritten to the file's exact bytes
  (raw lines, CRLF preserved, final-line terminator included; leading BOM
  excluded) and the edit proceeds; the file is read once per call, and a
  1 MB UTF-8 size guard skips huge files. Everything else is
  **report-only, never applied**: ambiguous or multi-match drift, a
  ratio-0.8 nearest-match report with the top candidate line ranges,
  or duplicate-occurrence line lists appended to the error.
  `edits[].oldText === newText`, empty `oldText`, and lone-`\r`
  (old-Mac) files are left to the built-in behavior unchanged.
- **Coaching** — when a tool call fails, a one-line `Henyo note:` hint is
  appended to the error the model sees. `edit` content-mismatch failures —
  the dominant class: text not found, text not unique, overlapping edits,
  or a no-op edit (`oldText` and `newText` identical) — each get a
  category-specific line, and the edit-fallback stage upgrades three of
  them when it can say more: not-found errors with a strong nearest match
  (ratio ≥ 0.8, within the 0.03 gap filter) gain a `candidates` report —
  top candidate line ranges and ratios — which replaces the plain hint,
  and not-found errors whose best match sits between 0.6 and 0.8 gain a
  near-miss hint pointing at the nearest region. Not-unique errors gain
  the exact occurrence line numbers. Overlap and no-op
  failures keep the plain one-line hint. `edit` shape-validation failures
  (both pi signatures: `Validation failed for tool "X"` and the older
  `Invalid input for tool "X"`) get the specific
  "`path` goes at the top level, next to `edits`" line, and every other
  tool a generic schema hint. On `Tool X not found` (hallucinated tool
  name) the hint instead lists the available tool names.
- **Prompt guideline** — two lines are appended to the system prompt (put
  `path` at the top level next to `edits`, and read the file immediately
  before `edit` so `edits[].oldText` is copied verbatim from a fresh read)
  so models emit the correct shape up front; each line is idempotent —
  skipped when already present, so a mid-session prompt upgrade picks up
  whichever one is missing.

Active by default; no configuration needed. The edit-fallback stage is
gated by the `editFallback` key (default `true`) — with it off (or with
`toolRepair` off) the hooks resolve byte-identical to the pre-fallback
behavior: no file reads, no rewrites, plain one-line coaching only.

Extended 2026-09-02 after the session-failure analysis (77% content mismatch
/ ~15% structural for the served Qwen models). Extended 2026-09-04 with the
edit-fallback stage (unique 1:1 whitespace-drift rewrite +
candidate/duplicate coaching).

**Safety model:** the rewrite fires only when the built-in exact match
would fail (so it never shadows a successful edit), only on a unique
1:1 whitespace-normalized match, and only when `oldText !== newText`;
the rewritten `oldText` is the file's exact bytes at that region, so the
resulting edit is the one the model intended, applied at the region the
built-in itself would accept. Anything ambiguous is reported (line
ranges / occurrence lines) instead of applied. Telemetry tracks the
outcome per call (`fixed` → `applied` / `failed`) so every auto-rewrite
is auditable after the fact.

**Upgrade caveat:** the exact-match predicate is a byte-level port of pi's
internal `dist/core/tools/edit-diff.js` (pi 0.84.2). After upgrading pi,
re-run `pnpm test` — if pi's matching semantics change, the port and its
"built-in would fail" guard must be re-derived before the fallback stays
sound.

**Log file:** telemetry outcomes are appended as JSONL to
`~/.pi/agent/tool-repair.jsonl` (non-`edit` successes are not logged — the
`ok` denominator is edit-only). Record shape:
`{ ts, tool, model, outcome, rules?, issues?, fingerprint, emission?, recoveredBy?, afterMs? }`
— `outcome` is `fixed` (a repair rule or an edit-fallback rewrite
applied), `ok` (denominator — every successful `edit` tool result),
`applied` (an edit-fallback rewrite was confirmed by the
subsequent successful tool result), `recovered` (a previously failed
`edit` on the same file succeeded — carries the original failure's
`fingerprint` and `issues`, plus `recoveredBy` (the successful call's
`toolCallId`) and `afterMs` (failure→recovery time in ms)), or `failed`
(validation actually failed — `issues` carries a shape diagnostic, a
content-mismatch category, or `unknown-tool` for hallucinated tool
names). Validation-class `failed` records may carry `emission`:
`truncated` (args cut off mid-payload — G3), `glued` (multiple object
emissions concatenated into one args value — G5), or `shape-quirk` (any
other unparseable shape) — so the truncation/glue gaps are measurable
from the log alone. Rewrite
records add `lineRange` (`{ startLine, endLine }`), `fileLines`,
`oldTextLines`, `editIndex` (for multi-edit calls), and `sha12` (first 12
hex of SHA-256 of the original `oldText` — argument values are never
logged). Fingerprint: `edit` events use the location fingerprint (hash of
the path basename + a normalized `oldText` prefix — an irreversible hash,
values never logged); non-edit events keep the shape fingerprint (hash of
the sorted top-level argument keys). Content-mismatch `issues` can carry
a subcategory after a colon:
`content-not-found:candidates`, `content-not-found:no-match`,
`content-not-unique:listed`, `too-large`.

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
jq -r .outcome ~/.pi/agent/tool-repair.jsonl | sort | uniq -c
```

### Compaction Retry Guard

Some models (observed: qwen3.8-27b via apollo-8002) "narrate" tool calls
in the tool-free summarization request. Pi treats any toolCall block in
the summary response as a hard failure ("Summarization attempted to call
a tool"), so auto-compaction dies and the session eventually runs out of
context. The guard takes over summary generation on
`session_before_compact`:

- **Strict plain-text system prompt** — the summary request forbids tool
calls, JSON tool blocks, and conversation continuation; reasoning is off
(saves output budget, fewer narration artifacts)
- **Targeted retries** — up to 3 attempts; each failure class (tool call
emitted / empty text / truncated response / API error) gets a targeted
repair note appended to the next attempt's prompt
- **Clean format** — the same structured checkpoint format pi's built-in
summarization uses (including the previous summary when one exists), so
future compactions merge cleanly
- **Safe fallback** — if it can't get clean text after 3 attempts it
falls back to pi's default compaction (with an `error` notify)

Gated by `compactionRetry` (default `false`).

**Legacy note:** the original standalone
`~/.pi/agent/extensions/compaction-retry.ts` pre-dates this port. It is
superseded — remove it when the core feature is enabled so the two don't
double-register `session_before_compact`.

## Settings

All henyo-pi-core features can be individually enabled or disabled via a `henyo` block in `~/.pi/agent/settings.json`. The block is created automatically on first install and extended when the extension adds new features — only *missing* keys are added (with their defaults); keys you have set are never modified. Absent or unknown keys behave as enabled, so a partial block is always safe.

### Feature Toggles

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `toolRepair` | `boolean` | `true` | Edit path repair + stringified-edits fix + all-tools validation coaching + unknown-tool hint + prompt guideline |
| `editFallback` | `boolean` | `true` | Fuzzy/nearest-match edit fallback: unique 1:1 whitespace-drift rewrite + candidate/duplicate coaching on content-mismatch errors |
| `footer` | `boolean` | `true` | Render compact footer (`name•model(level)•ctx%•path(branch)` + conditional status line) |
| `agentsMd` | `boolean` | `true` | Copy `SAMPLE_GLOBAL_AGENTS.md` to `~/.pi/agent/AGENTS.md` on first session (if it does not already exist) |
| `ttftTokps` | `boolean` | `true` | Working line with TTFT + tok/s (live estimate, exact when usage is reported, final readout) |
| `trace` | `boolean` | `false` | JSONL trace of every ttftTokps display decision (incl. the exact displayed string), size-rotated |
| `compactionRetry` | `boolean` | `false` | Compaction summary retry guard: strict plain-text prompt + up to 3 targeted retries; falls back to pi's default compaction |
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
    "toolRepair": true,
    "editFallback": true,
    "footer": true,
    "agentsMd": true,
    "ttftTokps": true,
    "trace": false,
    "compactionRetry": true,
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
    "toolRepair": false,
    "editFallback": false,
    "footer": false,
    "agentsMd": false,
    "ttftTokps": false,
    "trace": false,
    "compactionRetry": false,
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