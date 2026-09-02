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
 *    then hoist `edits[0].path` to top-level `path` (rule `extract-path`),
 *    then salvage `edits` strings corrupt beyond strict parse
 *    (`salvage-corrupt-edits`), recover garbled `path>` keys
 *    (`recover-garbled-path`), and drop incomplete entries
 *    (`drop-incomplete-edits`); one `fixed` log record carries the full
 *    rules array. Side effect: the assistant message is rewritten in place,
 *    so session history shows the corrected shape, not the raw mistake.
 * 2. `tool_result` (coaching) — on any tool's validation failure (both
 *    signatures: `Validation failed for tool "X"` and the older
 *    `Invalid input for tool "X"`), append a one-line hint to the error the
 *    model sees — `edit` gets the specific line, other tools a generic
 *    schema hint. On `Tool X not found`, append the available tool names
 *    from `getActiveTools()` (hallucinated names are coached, never
 *    remapped). On `edit` content-mismatch errors (not-found / not-unique /
 *    overlap / identical), append a targeted one-line hint — the dominant
 *    failure class for the served Qwen models (77% of observed edit errors).
 * 3. `before_agent_start` (prevention) — append two guideline lines to the
 *    system prompt (path shape + read-before-edit) so models emit the correct
 *    shape and fresh `oldText` in the first place; each line is deduped
 *    independently.
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

const READ_BEFORE_EDIT_LINE =
  'If you have not read the file this turn (or it may have changed since your last read), read it immediately before calling edit, and copy edits[].oldText verbatim from that fresh read.';

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

/**
 * Degeneration markers — where a corrupt `edits` string cut off mid-JSON and
 * the model started emitting the next tool call / thinking block / function
 * call. Built via concatenation so the raw marker sequences do not appear as
 * literals in this source (they trigger parser behavior downstream).
 */
const DEGENERATION_MARKERS: string[] = [
  '<too' + 'l_call',
  '<' + 'think' + '>',
  '<' + '/think' + '>',
  '<fu' + 'nction=',
];

/** Escape-aware scan of a JSON text: is the end inside an open string, and how many arrays are still open. */
function scanJsonTail(s: string): { inString: boolean; depth: number } {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (const c of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (c === '[') depth += 1;
      else if (c === ']') depth -= 1;
    }
  }
  return { inString, depth };
}

/**
 * Salvage `edits` strings that are corrupt beyond what
 * `repairStringifiedEdits` can handle (strict parse fails: truncated
 * mid-JSON, raw control chars, tag bleed from the next model emission).
 * Observed: 13 S3 cases (2026-09-02 session-failure analysis).
 *
 * Conservative by design (confirmed false-positive bar): fires only when
 * root `path` is a string AND the salvaged array has ≥1 entry with non-empty
 * string `oldText` and `newText`; otherwise the input stays untouched so the
 * validation error + coaching handles it as today.
 *
 * Pure-ish: mutates `input` when it fires. Returns `true` when `input.edits`
 * was replaced with the salvaged array. Transform, in order: cut at the
 * first degeneration marker, escape raw control chars (U+0000–U+001F), then
 * append closers for an end inside an open string/array (`"` then `]`).
 * A cut that leaves an entry object open is NOT repairable with those
 * closers — such payloads correctly stay untouched.
 */
export function salvageCorruptEdits(input: Record<string, unknown>): boolean {
  const edits = input.edits;
  if (typeof edits !== 'string') {
    return false;
  }
  try {
    JSON.parse(edits);
    return false; // parseable — not a corruption case
  } catch {
    // expected for a corrupt string
  }
  if (typeof input.path !== 'string') {
    return false;
  }

  let s = edits;
  // (a) cut at the first occurrence of any degeneration marker
  let cut = -1;
  for (const marker of DEGENERATION_MARKERS) {
    const i = s.indexOf(marker);
    if (i >= 0 && (cut < 0 || i < cut)) {
      cut = i;
    }
  }
  if (cut >= 0) {
    s = s.slice(0, cut);
  }
  // (b) escape raw control chars (U+0000–U+001F) to their JSON escapes —
  // char-wise on purpose: a regex for this range trips no-control-regex
  s = s
    .split('')
    .map((c) =>
      c.charCodeAt(0) < 0x20 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c,
    )
    .join('');
  // (c) append closers when the end is inside an open string/array
  const { inString, depth } = scanJsonTail(s);
  const tryParse = (t: string): unknown | undefined => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(s);
  if (parsed === undefined && (inString || depth > 0)) {
    s += (inString ? '"' : '') + ']'.repeat(Math.max(depth, 0));
    parsed = tryParse(s);
  }
  if (parsed === undefined) {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }
  }
  const hasComplete = parsed.some((entry) => {
    const e = entry as Record<string, unknown>;
    return (
      typeof e.oldText === 'string' &&
      e.oldText !== '' &&
      typeof e.newText === 'string' &&
      e.newText !== ''
    );
  });
  if (!hasComplete) {
    return false;
  }
  input.edits = parsed;
  return true;
}

/** Mangled parameter-tag bleed observed in one served-model payload: `path>` (the class also matches plain `path`). */
const GARBLED_PATH_KEY = /^path[>" ]*$/;

/**
 * Recover a garbled `path` key (e.g. `path>` — a mangled parameter-tag
 * bleed) nested inside an edit entry, moving it to the top level.
 * Observed: 1 of the 6 S4/S5 cases (2026-09-02 session-failure analysis).
 *
 * Pure-ish: mutates `input` when it fires. Returns `true` when a garbled key
 * was found and moved. Guard: no string `path` at root, `edits` is a
 * non-empty array of plain objects, and at least one entry has a string
 * value under a `path[>" ]*` key. Moves the first such value and deletes
 * the garbled key from all entries.
 */
export function recoverGarbledPath(input: Record<string, unknown>): boolean {
  if (typeof input.path === 'string') {
    return false;
  }
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return false;
  }
  const entries = edits as Record<string, unknown>[];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }
  }
  let value: string | undefined;
  outer: for (const entry of entries) {
    for (const [key, v] of Object.entries(entry)) {
      if (GARBLED_PATH_KEY.test(key) && typeof v === 'string') {
        value = v;
        break outer;
      }
    }
  }
  if (value === undefined) {
    return false;
  }
  input.path = value;
  for (const entry of entries) {
    for (const key of Object.keys(entry)) {
      if (GARBLED_PATH_KEY.test(key)) {
        delete entry[key];
      }
    }
  }
  return true;
}

/**
 * Drop `edits` entries that lack a string `oldText` or `newText` (the S6
 * shape: 5 of 117 observed edit errors), keeping the complete ones so the
 * call can proceed instead of failing validation on one bad entry.
 *
 * Pure-ish: mutates `input` when it fires. Returns `true` when `input.edits`
 * was replaced with only the complete entries. Guard: `edits` is a
 * non-empty array of plain objects, at least one entry is incomplete, and
 * at least one entry is complete (zero complete → false, untouched).
 */
export function dropIncompleteEdits(input: Record<string, unknown>): boolean {
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return false;
  }
  const entries = edits as Record<string, unknown>[];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }
  }
  const isComplete = (e: Record<string, unknown>): boolean =>
    typeof e.oldText === 'string' &&
    e.oldText !== '' &&
    typeof e.newText === 'string' &&
    e.newText !== '';
  const complete = entries.filter(isComplete);
  if (complete.length === 0 || complete.length === entries.length) {
    return false;
  }
  input.edits = complete;
  return true;
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
      if (salvageCorruptEdits(args)) rules.push('salvage-corrupt-edits');
      if (recoverGarbledPath(args)) rules.push('recover-garbled-path');
      if (dropIncompleteEdits(args)) rules.push('drop-incomplete-edits');
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

  // Hook 3 (O5): prevention — two guideline lines in the system prompt,
  // each with its own idempotency check (a prompt upgraded mid-session has
  // the old line but not the new one).
  pi.on('before_agent_start', (event) => {
    if (!opts.enabled) return undefined;
    let prompt = event.systemPrompt;
    let changed = false;
    if (!prompt.includes(PROMPT_LINE)) {
      prompt = `${prompt}\n\n${PROMPT_LINE}`;
      changed = true;
    }
    if (!prompt.includes(READ_BEFORE_EDIT_LINE)) {
      prompt = `${prompt}\n\n${READ_BEFORE_EDIT_LINE}`;
      changed = true;
    }
    return changed ? { systemPrompt: prompt } : undefined;
  });
}
