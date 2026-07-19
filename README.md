# henyo-pi-core

Pi coding agent extensions for long-horizon agentic SWE using local models.

## Structure

```
henyo-pi-core/
├── package.json          # Extension manifest with pi entry point
├── .gitignore
├── README.md
├── src/
│   ├── index.ts          # Main extension entry point (registers all commands/tools/etc.)
│   ├── commands/         # Custom slash commands
│   │   ├── cwd.ts
│   │   └── newp.ts
│   ├── tools/            # Custom tool definitions
│   ├── events/           # Event handler modules
│   ├── utils/            # Shared utilities
│   └── resources/        # Static resources (prompts, templates, configs)
```

## Registered Commands

### `/cwd [path]`

Switch to another project directory and start a new session in the target dir.
- With no args: shows the current working directory.
- With a path argument: creates a new session in that directory.

### `/newp <prompt>`

Start a new session with an initial prompt. The prompt is sent as the
first user message in the new session.

## Development

See [Pi Extensions Docs](https://www.pi.com/docs/extensions) for the extension API reference.