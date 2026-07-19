# henyo-pi-core

Pi coding agent extensions for long-horizon agentic SWE using local models.

## Installation

When installed via `npm install`, the package runs a `postinstall` script that:

1. **Initializes git submodules** — pulls in `@r3b1s/pi-repair-layer` (see [Bundled Extensions](#bundled-extensions)).
2. **Seeds `~/.pi/agent/AGENTS.md`** — copies `SAMPLE_GLOBAL_AGENTS.md` to your pi config directory on first install only (if the file doesn't already exist). This provides default guidelines for new users.

## Structure

```
henyo-pi-core/
├── package.json          # Extension manifest with pi entry point
├── .gitignore
├── README.md
├── eslint.config.mjs     # ESLint flat config (style rules + Prettier integration)
├── .prettierrc.json      # Prettier configuration
├── .prettierignore       # Files to exclude from formatting
├── tsconfig.json         # TypeScript compiler options
├── vitest.config.ts      # Vitest test runner config
├── index.ts              # Re-export for pi extension loading
├── skills/               # Bundled pi skills
│   └── deep-research/    # Multi-step autonomous research workflow
└── src/
    ├── index.ts          # Extension factory (registers commands, tools, events)
    └── commands/         # Custom slash commands
        ├── cwd.ts        # /cwd: switch project directory (new session in target dir)
        └── newp.ts       # /newp: start a new session with an initial prompt
```

## Registered Commands

### `/cwd [path]`

Switch to another project directory and start a new session in the target dir.
- With no args: shows the current working directory.
- With a path argument: creates a new session in that directory using `SessionManager`.

### `/newp <prompt>`

Start a new session with an initial prompt. The prompt is sent as the first
user message in the new session.

## Bundled Skills

### `/skill:deep-research`

A structured methodology for conducting deep, multi-step research. Guides the agent through planning, iterative retrieval, cross-source validation, and synthesis into a structured report with full citations. Use for complex research questions, competitive analysis, literature reviews, or any task requiring thorough investigation beyond a single search.

**Workflow:** Plan → Retrieve → Cross-Validate → Synthesize → Report

## Bundled Extensions

### Tool Call Repair

This extension includes [@r3b1s/pi-repair-layer](https://pi.dev/packages/@r3b1s/pi-repair-layer) as a git submodule. It validates and repairs malformed tool calls from LLMs before they reach the agent — fixing null fields, stringified arrays, wrong field names, markdown auto-links, anchor bleed, and more.

No configuration needed. Repair is active by default.

**View repair stats:** `/repair-stats`
**Configure:** `/repair-settings`

The submodule is pinned to a specific upstream commit. Update with:
```bash
git -C .ext/pi-repair-layer pull origin main
```

## Development

### Prerequisites

- Node.js 18+
- Globally installed [Pi coding agent](https://pi.dev) (`npm install -g @earendil-works/pi-coding-agent`)

### Available Scripts

```bash
npm test          # Run Vitest unit tests
npm run lint      # Type-check (tsc) + ESLint style checks
npm run format    # Check Prettier formatting
npm run format:fix  # Auto-format with Prettier
npm test -- --coverage  # Run tests with coverage report (80% thresholds)
```

### Architecture

The extension follows a factory pattern — `src/index.ts` exports a default function that receives the Pi `ExtensionAPI` and registers all commands, tools, and event handlers. This function is invoked by pi when loading the extension.

**Command registration:** Each command lives in its own file under `src/commands/`, exporting a function that accepts the API instance and calls `pi.registerCommand()`.

**Session management:** The `/cwd` command uses `SessionManager.create(target)` which handles path derivation and header serialization, keeping session metadata consistent with pi's expected format.

### Testing

Tests use Vitest with mocked pi-coding-agent internals. Each test file covers its corresponding command handler, including edge cases for error conditions and cancellation scenarios. Coverage thresholds are set at 80%.

## API Reference

See [Pi Extensions Docs](https://pi.dev/docs/extensions) for the extension API reference.