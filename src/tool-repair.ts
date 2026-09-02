/**
 * Standalone tool repair — event hooks only, no tool overrides.
 *
 * What it fixes: some models (observed: Qwen 3.6 "dumb-zone" runs, Jul 26–Aug
 * 22 2026) emit broken `edit` arguments — `path` nested inside `edits[0]`
 * instead of at the top level (validation fails with "required: path"), or
 * the whole `edits` array stringified as JSON (validation fails with
 * "expected array"). It also coaches on validation failures of ANY tool
 * (both pi error signatures) and on hallucinated tool names. Provenance:
 * 60 repaired vs 56 unrepairable telemetry events; stringified `edits` was
 * the dominant unhandled shape (13 old-telemetry + 4 post-deploy + 11
 * `Invalid input` era).
 *
 * Three hooks:
 * 1. `message_end` (repair) — for `edit` calls, before execution: parse a
 *    stringified `edits` back into an array (rule `parse-stringified-edits`),
 *    then hoist `edits[0].path` to top-level `path` (rule `extract-path`);
 *    one `fixed` log record carries the full rules array. Side effect: the
 *    assistant message is rewritten in place, so session history shows the
 *    corrected shape, not the raw mistake.
 * 2. `tool_result` (coaching) — on any tool's validation failure (both
 *    signatures: `Validation failed for tool "X"` and the older
 *    `Invalid input for tool "X"`), append a one-line hint to the error the
 *    model sees — `edit` gets the specific line, other tools a generic
 *    schema hint. On `Tool X not found`, append the available tool names
 *    from `getActiveTools()` (hallucinated names are coached, never
 *    remapped). On `edit` content-mismatch errors (not-found / not-unique /
 *    overlap / identical), append a targeted one-line hint — the dominant
 *    failure class for the served Qwen models (77% of observed edit errors).
 * 3. `before_agent_start` (prevention) — append one guideline line to the
 *    system prompt so models emit the correct shape in the first place.
 *
 * Telemetry: `~/.pi/agent/tool-repair.jsonl` (JSONL; `fixed` and
 * `failed` outcomes only — healthy no-ops are not logged). Fingerprint is
 * `fnv1a("<tool>::<sorted keys>")` for all tools (uniform format; historical
 * edit fingerprints are non-comparable).
 *
 * Because no tools are registered or overridden, this coexists with any
 * repair layer that wraps `prepareArguments`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const COACHING_LINE =
  'Henyo note: for the edit tool, put `path` at the top level next to `edits` (not inside an edit object), and keep `edits` an array of { oldText, newText } objects.';

const PROMPT_LINE =
  'For the `edit` tool, put `path` at the top level of the arguments, next to `edits` — not inside individual edit objects.';

const GENERIC_COACHING_LINE =
  "Henyo note: the arguments must match the tool's schema exactly — required fields go at the top level of the arguments. Re-emit the call with the complete argument object.";

const UNKNOWN_TOOL_SIGNATURE = /^Tool\s+"?[A-Za-z0-9_.-]*"? not found$/;

/**
 * Coaching for `edit` content-mismatch errors — the dominant failure class
 * for the served Qwen models (77% of observed edit errors, 2026-09-02
 * session-failure analysis). Ordered, first match on the error's first line
 * wins. `line` is raw — the hook prefixes `Henyo note: `.
 */
const CONTENT_ERROR_RULES: { re: RegExp; category: string; line: string }[] = [
  {
    re: /Could not find (edits\[\d+\] in|the exact text in)/,
    category: 'content-not-found',
    line: 'Re-read the file now (it may have changed since your last read) and copy oldText verbatim from the fresh read, including exact whitespace and newlines.',
  },
  {
    re: /Found \d+ occurrences/,
    category: 'content-not-unique',
    line: 'The text occurs more than once in the file. Extend oldText with enough surrounding lines to be unique.',
  },
  {
    re: /edits\[\d+\] and edits\[\d+\] overlap/,
    category: 'content-overlap',
    line: 'The two edit regions overlap. Merge them into one edit targeting the union.',
  },
  {
    re: /No changes made.*identical content/,
    category: 'content-identical',
    line: 'newText equals oldText — this edit is a no-op. Re-check what you intended to change.',
  },
];

/** Fallback for `getActiveTools()` when it throws (telemetry must not break a run). */
const FALLBACK_TOOL_LIST = 'bash, read, edit, write, grep, find, ls';

interface LogRecord {
  ts: string;
  tool: string;
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
 * Replace `edits` when the model emitted it as a JSON string
 * (`"edits": "[{\"oldText\":…}]"` — whole array stringified instead of an
 * object), so validation fails with "expected array". Observed: ~28
 * historical + 4 recent (Aug 22) broken calls, the dominant unhandled shape.
 *
 * Pure-ish: mutates `input` when it fires. Returns `true` when `input.edits`
 * was replaced with the parsed array. Strict guard (plan assumption 3): the
 * parse must succeed AND yield an array AND every element must be a plain
 * object (non-null, not an array). Anything else — invalid JSON, a JSON
 * scalar, an array with junk elements — stays untouched so the validation
 * error + coaching handles it (no false-positive `fixed` records).
 */
export function repairStringifiedEdits(input: Record<string, unknown>): boolean {
  if (typeof input.edits !== 'string') {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.edits);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  for (const element of parsed) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      return false;
    }
  }
  input.edits = parsed;
  return true;
}

/** Settings resolution: `toolRepair` default on (absent key = enabled). */
export function resolveToolRepair(s: { toolRepair?: boolean }): boolean {
  return s.toolRepair ?? true;
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
 * Fingerprint of the args SHAPE only — sorted top-level keys.
 * Argument values never enter the log. Uniform across all tools
 * (plan decision 4); the legacy edit `::edits=<type>` suffix is dropped,
 * so historical edit fingerprints are non-comparable.
 */
function shapeFingerprint(tool: string, input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input as Record<string, unknown>).sort();
    return fnv1a(`${tool}::${keys.join('|')}`);
  }
  return fnv1a(`${tool}::not-an-object:${typeof input}`);
}

/**
 * Shape diagnostics for the `issues` field of `failed` records.
 * Sorted keys for all tools (the old edit format was unsorted); a
 * tool-agnostic `;edits=<type>` suffix is appended whenever the input
 * object has an `edits` field (plan decision 4).
 */
function shapeDiagnostics(_tool: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return `not-an-object(${typeof input})`;
  }
  const record = input as Record<string, unknown>;
  let issues = `keys=[${Object.keys(record).sort().join(',')}]`;
  if ('edits' in record) {
    const edits = record.edits;
    const editsType = Array.isArray(edits) ? `array(${edits.length})` : typeof edits;
    issues += `;edits=${editsType}`;
  }
  return issues;
}

/**
 * Register the three hooks. `opts.enabled` gates all three at runtime so the
 * extension can be registered unconditionally; `opts.logPath` overrides the
 * default `~/.pi/agent/tool-repair.jsonl` (used by tests).
 */
export function toolRepairExtension(
  pi: ExtensionAPI,
  opts: { enabled: boolean; logPath?: string },
): void {
  const appendLog = (record: LogRecord): void => {
    try {
      const file = opts.logPath ?? join(getAgentDir(), 'tool-repair.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + '\n');
    } catch {
      // Telemetry must never break a run.
    }
  };

  // Hook 1 (O1): repair — hoist nested `path` before execution.
  pi.on('message_end', (event, ctx) => {
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
      const rules: string[] = [];
      if (repairStringifiedEdits(args)) rules.push('parse-stringified-edits');
      if (hoistEditPath(args)) rules.push('extract-path');
      if (rules.length > 0) {
        changed = true;
        appendLog({
          ts: new Date().toISOString(),
          tool: 'edit',
          model: ctx.model?.id,
          outcome: 'fixed',
          rules,
          fingerprint: shapeFingerprint('edit', args),
        });
        return { ...entry, arguments: args };
      }
      return entry;
    });

    if (!changed) return undefined;
    return { message: { ...message, content: newContent } };
  });

  // Hook 2 (O3): coaching — (a) unknown-tool errors get the available tool
  // list (never remapped — plan assumption 6); (b) validation failures on
  // any tool, both pi error signatures (`Validation failed for tool "X"`
  // and the older `Invalid input for tool "X"`) get a schema hint. edit gets
  // the specific line; every other tool gets the generic one.
  pi.on('tool_result', (event, ctx) => {
    if (!opts.enabled) return undefined;
    if (!event.isError) return undefined;
    const originalText = event.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    if (UNKNOWN_TOOL_SIGNATURE.test(originalText.split('\n')[0] ?? '')) {
      let toolList: string;
      try {
        toolList = pi.getActiveTools().join(', ');
      } catch {
        toolList = FALLBACK_TOOL_LIST;
      }
      const input = event.input as unknown;
      appendLog({
        ts: new Date().toISOString(),
        tool: event.toolName,
        model: ctx.model?.id,
        outcome: 'failed',
        issues: 'unknown-tool',
        fingerprint: shapeFingerprint(event.toolName, input),
      });

      return {
        content: [
          {
            type: 'text',
            text: `${originalText}\n\nHenyo note: no such tool. Available tools: ${toolList} — re-emit the call with one of those.`,
          },
        ],
      };
    }

    // Content-mismatch errors (edit only — the signatures are edit-specific):
    // the dominant failure class for the served Qwen models. Coached with a
    // targeted one-line hint; telemetry records the category, not shape.
    if (event.toolName === 'edit') {
      const firstLine = originalText.split('\n')[0] ?? '';
      const rule = CONTENT_ERROR_RULES.find((r) => r.re.test(firstLine));
      if (rule) {
        const input = event.input as unknown;
        appendLog({
          ts: new Date().toISOString(),
          tool: 'edit',
          model: ctx.model?.id,
          outcome: 'failed',
          issues: rule.category,
          fingerprint: shapeFingerprint('edit', input),
        });

        return {
          content: [{ type: 'text', text: `${originalText}\n\nHenyo note: ${rule.line}` }],
        };
      }
    }

    if (
      !/Validation failed for tool "[a-z_]+"/.test(originalText) &&
      !/Invalid input for tool "[a-z_]+"/.test(originalText)
    ) {
      return undefined;
    }

    const coachingLine = event.toolName === 'edit' ? COACHING_LINE : GENERIC_COACHING_LINE;
    const input = event.input as unknown;
    appendLog({
      ts: new Date().toISOString(),
      tool: event.toolName,
      model: ctx.model?.id,
      outcome: 'failed',
      issues: shapeDiagnostics(event.toolName, input),
      fingerprint: shapeFingerprint(event.toolName, input),
    });

    return {
      content: [{ type: 'text', text: `${originalText}\n\n${coachingLine}` }],
    };
  });

  // Hook 3 (O5): prevention — one guideline line in the system prompt.
  pi.on('before_agent_start', (event) => {
    if (!opts.enabled) return undefined;
    if (event.systemPrompt.includes(PROMPT_LINE)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${PROMPT_LINE}` };
  });
}
