/**
 * Standalone edit path fix — event hooks only, no tool overrides.
 *
 * What it fixes: some models (observed: Qwen 3.6 "dumb-zone" runs, Jul 26–Aug
 * 9 2026) emit the `edit` tool's `path` argument nested inside `edits[0]`
 * instead of at the top level, so validation fails with "required: path".
 * Provenance: 60 repaired telemetry events, all this one rule.
 *
 * Three hooks:
 * 1. `message_end` (repair) — hoist `edits[0].path` to top-level `path` before
 *    the tool call executes. Side effect: the assistant message is rewritten
 *    in place, so session history shows the corrected shape, not the raw
 *    mistake.
 * 2. `tool_result` (coaching) — when an `edit` call fails validation, append
 *    a one-line hint to the error the model sees.
 * 3. `before_agent_start` (prevention) — append one guideline line to the
 *    system prompt so models emit the correct shape in the first place.
 *
 * Telemetry: `~/.pi/agent/edit-path-repair.jsonl` (JSONL; `fixed` and
 * `failed` outcomes only — healthy no-ops are not logged).
 *
 * Because no tools are registered or overridden, this coexists with any
 * repair layer that wraps `prepareArguments`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';

const COACHING_LINE =
  'Henyo note: for the edit tool, put `path` at the top level next to `edits` (not inside an edit object), and keep `edits` an array of { oldText, newText } objects.';

const PROMPT_LINE =
  'For the `edit` tool, put `path` at the top level of the arguments, next to `edits` — not inside individual edit objects.';

const VALIDATION_SIGNATURE = 'Validation failed for tool "edit"';

interface LogRecord {
  ts: string;
  tool: 'edit';
  model?: string;
  outcome: 'fixed' | 'failed';
  rules?: string[];
  issues?: string;
  fingerprint?: string;
}

/**
 * Hoist `edits[0].path` to top-level `path` for the edit tool.
 *
 * Pure-ish: mutates `input` when it fires. Returns `true` when the object was
 * changed. Guard logic ported verbatim from the deleted
 * `extractPathMiddleware` (note string dropped):
 * - `path` missing at the top level
 * - `edits` is a non-empty array
 * - `edits[0]` is a plain object with a string `path`
 */
export function hoistEditPath(input: Record<string, unknown>): boolean {
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return false;
  }

  const firstEdit = edits[0];
  if (!firstEdit || typeof firstEdit !== 'object') {
    return false;
  }

  // Only fire if path is missing at top level
  if ('path' in input) {
    return false;
  }

  const pathValue = (firstEdit as Record<string, unknown>)['path'];
  if (typeof pathValue !== 'string') {
    return false;
  }

  // Extract path to top level
  input['path'] = pathValue;

  // Remove path from all edit objects
  for (const edit of edits) {
    if (edit && typeof edit === 'object' && 'path' in edit) {
      delete (edit as Record<string, unknown>)['path'];
    }
  }

  return true;
}

/**
 * Settings resolution: new `editPathFix` wins; legacy `toolRepair` honored
 * only when `editPathFix` is unset; default on.
 */
export function resolveEditPathFix(s: {
  editPathFix?: boolean;
  toolRepair?: boolean;
}): boolean {
  return s.editPathFix ?? s.toolRepair ?? true;
}

/** FNV-1a 32-bit hash (same algorithm as the old telemetry fingerprint). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fingerprint of the args SHAPE only — sorted top-level keys + `edits` type.
 * Argument values never enter the log.
 */
function shapeFingerprint(input: unknown): string {
  let keys: string[];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    keys = Object.keys(input as Record<string, unknown>).sort();
  } else {
    keys = [`not-an-object:${typeof input}`];
  }
  const edits =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).edits
      : undefined;
  const editsType = Array.isArray(edits)
    ? `array(${edits.length})`
    : edits === undefined
      ? 'missing'
      : typeof edits;
  return fnv1a(`edit::${keys.join('|')}::edits=${editsType}`);
}

/** Shape diagnostics for the `issues` field of `failed` records. */
function shapeDiagnostics(input: unknown): string {
  let keys: string;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    keys = `[${Object.keys(input as Record<string, unknown>).join(',')}]`;
  } else {
    keys = `not-an-object(${typeof input})`;
  }
  const edits =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).edits
      : undefined;
  const editsType = Array.isArray(edits)
    ? `array(${edits.length})`
    : edits === undefined
      ? 'missing'
      : typeof edits;
  return `keys=${keys};edits=${editsType}`;
}

/**
 * Register the three hooks. `opts.enabled` gates all three at runtime so the
 * extension can be registered unconditionally; `opts.logPath` overrides the
 * default `~/.pi/agent/edit-path-repair.jsonl` (used by tests).
 */
export function editPathRepairExtension(
  pi: ExtensionAPI,
  opts: { enabled: boolean; logPath?: string },
): void {
  const appendLog = (record: LogRecord): void => {
    try {
      const file =
        opts.logPath ?? join(getAgentDir(), 'edit-path-repair.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + '\n');
    } catch {
      // Telemetry must never break a run.
    }
  };

  // Hook 1 (O1): repair — hoist nested `path` before execution.
  pi.on('message_end', (event: MessageEndEvent, ctx: ExtensionContext) => {
    if (!opts.enabled) return undefined;
    const message = event.message;
    if (message.role !== 'assistant') return undefined;
    const content = message.content;
    if (!Array.isArray(content)) return undefined;

    let changed = false;
    const newContent = content.map((entry) => {
      if (
        entry.type !== 'toolCall' ||
        entry.name !== 'edit' ||
        entry.arguments === null ||
        typeof entry.arguments !== 'object' ||
        Array.isArray(entry.arguments)
      ) {
        return entry;
      }
      const args = entry.arguments as Record<string, unknown>;
      if (hoistEditPath(args)) {
        changed = true;
        appendLog({
          ts: new Date().toISOString(),
          tool: 'edit',
          model: ctx.model?.id,
          outcome: 'fixed',
          rules: ['extract-path'],
          fingerprint: shapeFingerprint(args),
        });
        return { ...entry, arguments: args };
      }
      return entry;
    });

    if (!changed) return undefined;
    return { message: { ...message, content: newContent } };
  });

  // Hook 2 (O3): coaching — hint on validation failure.
  pi.on('tool_result', (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!opts.enabled) return undefined;
    if (event.toolName !== 'edit' || !event.isError) return undefined;
    const originalText = event.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (!originalText.includes(VALIDATION_SIGNATURE)) return undefined;

    const input = event.input as unknown;
    appendLog({
      ts: new Date().toISOString(),
      tool: 'edit',
      model: ctx.model?.id,
      outcome: 'failed',
      issues: shapeDiagnostics(input),
      fingerprint: shapeFingerprint(input),
    });

    return {
      content: [{ type: 'text', text: `${originalText}\n\n${COACHING_LINE}` }],
    };
  });

  // Hook 3 (O5): prevention — one guideline line in the system prompt.
  pi.on(
    'before_agent_start',
    (event: BeforeAgentStartEvent) => {
      if (!opts.enabled) return undefined;
      if (event.systemPrompt.includes(PROMPT_LINE)) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${PROMPT_LINE}` };
    },
  );
}
