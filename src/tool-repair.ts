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
 *    rules array. When `opts.editFallbackEnabled` is true, a further stage
 *    runs after the shape rules: whitespace-drifted `edits[].oldText` whose
 *    normalized form matches the file uniquely 1:1 is rewritten to the
 *    file's exact bytes (rule `whitespace-normalize-oldtext`) so the
 *    built-in's exact match succeeds — matching/reporting logic lives in
 *    the pure `edit-fallback.ts`. Side effect: the assistant message is
 *    rewritten in place, so session history shows the corrected shape and
 *    rewritten oldText, not the raw mistake.
 * 2. `tool_result` (coaching) — on any tool's validation failure (both
 *    signatures: `Validation failed for tool "X"` and the older
 *    `Invalid input for tool "X"`), append a one-line hint to the error the
 *    model sees — `edit` gets the specific line, other tools a generic
 *    schema hint. On `Tool X not found`, append the available tool names
 *    from `getActiveTools()` (hallucinated names are coached, never
 *    remapped). On `edit` content-mismatch errors (not-found / not-unique /
 *    overlap / identical), append a targeted one-line hint — the dominant
 *    failure class for the served Qwen models (77% of observed edit
 *    errors) — which, when `opts.editFallbackEnabled` is true, is upgraded
 *    to the full nearest-match candidate report (not-found) or the
 *    occurrence line-number list (not-unique); successful calls that used a
 *    rewritten `oldText` log an `applied` record (rewrite→result
 *    correlation via a bounded in-memory toolCallId map).
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
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolveNodePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { classifyEdit, normalizeToLF, splitLinesWithEndings } from './edit-fallback.js';

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
  outcome: 'fixed' | 'failed' | 'applied' | 'ok';
  rules?: string[];
  issues?: string;
  fingerprint?: string;
  // Fuzzy-edit fallback records (plan assumption 6) — argument values never
  // reach the log; `sha12` is the only trace of the original oldText.
  toolCallId?: string;
  editIndex?: number;
  lineRange?: { startLine: number; endLine: number };
  fileLines?: number;
  oldTextLines?: number;
  sha12?: string;
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

/** Settings resolution: `editFallback` default on (absent key = enabled). */
export function resolveEditFallback(s: { editFallback?: boolean }): boolean {
  return s.editFallback ?? true;
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

/** Prefix length (chars) of the normalized oldText in the location fingerprint (plan assumption A6). */
const FP_PREFIX_LEN = 120;

/**
 * Normalize text for the location fingerprint: `\r\n`→`\n`, trim the whole,
 * collapse runs of whitespace within each line to a single space. CRLF /
 * whitespace variants of the same oldText then hash identically.
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' '))
    .join('\n');
}

/**
 * Discriminating fingerprint for `edit` telemetry events — basename of the
 * top-level `path` plus a normalized `oldText` prefix, hashed. Argument
 * values never reach the log; unlike `shapeFingerprint` (constant across
 * all edit shapes) this distinguishes failure sites.
 *
 * Returns `undefined` when the input has no top-level string `path` or no
 * resolvable oldText — callers fall back to `shapeFingerprint`.
 * oldText source: string `edits` (raw stringified payload) or an array of
 * objects (string `oldText` values joined with `\n` in order); an array
 * without string `oldText` values (incl. `[]`) yields `undefined`.
 */
export function editLocationFingerprint(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== 'string') {
    return undefined;
  }
  const edits = record.edits;
  let merged: string | undefined;
  if (typeof edits === 'string') {
    merged = edits;
  } else if (Array.isArray(edits)) {
    const texts: string[] = [];
    for (const entry of edits) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).oldText === 'string'
      ) {
        texts.push((entry as Record<string, unknown>).oldText as string);
      }
    }
    if (texts.length > 0) merged = texts.join('\n');
  }
  if (merged === undefined) {
    return undefined;
  }
  return fnv1a(
    `edit::loc::${basename(path)}::${normalizeForFingerprint(merged).slice(0, FP_PREFIX_LEN)}`,
  );
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

/** Unicode-space variants — the built-in path resolution maps them to plain spaces. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve an `edit` tool `path` the way the built-in does (pi
 * `resolveToCwd` = `resolvePath(path, cwd, {normalizeUnicodeSpaces: true,
 * stripAtPrefix: true})`): unicode spaces → plain, strip a leading `@`,
 * `~` → home dir, `file://` URL → path, absolute kept, relative resolved
 * against `cwd`.
 *
 * [assumption]: the built-in's win32 MSYS/Cygwin/WSL drive conversion is
 * omitted — on those platforms a shell-style path stays unreadable here, so
 * the rewrite simply does not fire and the built-in's own resolution handles
 * the call (byte-identical fallback to today's behavior).
 */
function resolveEditPath(filePath: string, cwd: string): string {
  let p = filePath.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) {
    p = p.slice(1);
  }
  if (p === '~') {
    return homedir();
  }
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  if (/^file:\/\//.test(p)) {
    return fileURLToPath(p);
  }
  return isAbsolute(p) ? p : resolveNodePath(cwd, p);
}

/** First 12 hex chars of SHA-256 — argument values never reach the log. */
function sha12(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** Bounded in-memory rewrite→result correlation map (plan assumption 6). */
const PENDING_REWRITE_CAP = 100;

interface PendingRewrite {
  path: string;
  editIndex: number;
  lineRange: { startLine: number; endLine: number };
  fileLines: number;
  oldTextLines: number;
  sha12: string;
}

/** Insert a pending rewrite record; evict the oldest toolCallIds FIFO past the cap. */
function rememberRewrite(
  pending: Map<string, PendingRewrite[]>,
  toolCallId: string,
  record: PendingRewrite,
): void {
  const list = pending.get(toolCallId);
  if (list) {
    list.push(record);
  } else {
    pending.set(toolCallId, [record]);
  }
  const total = (): number => [...pending.values()].reduce((n, l) => n + l.length, 0);
  while (total() > PENDING_REWRITE_CAP) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
}

/**
 * Fuzzy/nearest-match rewrite stage (plan step 3.1). Runs AFTER the five
 * shape rules (normalize needs the final shape). For each `edits[i]` entry,
 * `classifyEdit` against the current file; on `rewrite` the entry's
 * `oldText` is replaced in place with the file's exact bytes (the built-in
 * then applies it via its exact-match path) and a `fixed` log record + a
 * pending-map entry are recorded. Unreadable or missing file → no rewrite,
 * no log, no throw. Returns the number of rewrites applied.
 */
async function applyEditFallback(
  args: Record<string, unknown>,
  toolCallId: string,
  cwd: string,
  model: string | undefined,
  pending: Map<string, PendingRewrite[]>,
  appendLog: (record: LogRecord) => void,
): Promise<number> {
  const path = args.path;
  if (typeof path !== 'string') return 0;
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return 0;
  let content: string;
  try {
    content = await readFile(resolveEditPath(path, cwd), 'utf8');
  } catch {
    return 0;
  }
  const fileLines = splitLinesWithEndings(normalizeToLF(content)).length;
  const timestamp = new Date().toISOString();
  const fingerprint = shapeFingerprint('edit', args);
  let count = 0;
  for (let i = 0; i < edits.length; i++) {
    const entry = edits[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const edit = entry as Record<string, unknown>;
    const oldText = edit.oldText;
    const newText = edit.newText;
    if (typeof oldText !== 'string' || typeof newText !== 'string') continue;
    const result = classifyEdit(path, content, oldText, newText);
    if (result.class !== 'rewrite' || !result.rewrittenOldText || !result.lineRange) {
      continue;
    }
    edit.oldText = result.rewrittenOldText;
    const oldTextLines = splitLinesWithEndings(normalizeToLF(oldText)).length;
    const record: PendingRewrite = {
      path,
      editIndex: i,
      lineRange: result.lineRange,
      fileLines,
      oldTextLines,
      sha12: sha12(oldText),
    };
    rememberRewrite(pending, toolCallId, record);
    appendLog({
      ts: timestamp,
      tool: 'edit',
      model,
      outcome: 'fixed',
      rules: ['whitespace-normalize-oldtext'],
      fingerprint,
      toolCallId,
      editIndex: i,
      lineRange: result.lineRange,
      fileLines,
      oldTextLines,
      sha12: record.sha12,
    });
    count += 1;
  }
  return count;
}

/** Upgrade produced for a content-mismatch failure (plan step 3.2). */
interface ContentErrorEnhancement {
  /** Telemetry `issues` subcategory (plan 3.2). */
  issues: string;
  /** `true`: replace the one-line hint; `false`: append after it. */
  replace: boolean;
  /** Report body / near-miss hint (no `Henyo note:` prefix). */
  extra: string;
}

/**
 * Re-classify a content-mismatch failure against the CURRENT file state
 * (plan step 3.2). Multi-edit: the failing `edits[i]` is scoped from the
 * error's first line (`edits[\d+]`). Returns null when no upgrade
 * qualifies (file unreadable, shape not editable, class `none`/`rewrite` —
 * e.g. the file changed since the model's read) so the existing one-line
 * hint stays untouched (assumption 11: no behavior regression).
 *
 * [assumption]: `duplicates` under a not-FOUND error (the file changed
 * after the model's read) is not reported — outside the plan's
 * subcategory list; the one-line hint suffices.
 */
async function classifyContentError(
  category: string,
  firstLine: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<ContentErrorEnhancement | null> {
  const path = input.path;
  const edits = input.edits;
  if (typeof path !== 'string' || !Array.isArray(edits)) return null;
  let editIndex = 0;
  const named = firstLine.match(/edits\[(\d+)\]/);
  if (named) editIndex = Number(named[1]);
  const entry = edits[editIndex];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const edit = entry as Record<string, unknown>;
  const oldText = edit.oldText;
  const newText = edit.newText;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
  let content: string;
  try {
    content = await readFile(resolveEditPath(path, cwd), 'utf8');
  } catch {
    return null;
  }
  const result = classifyEdit(path, content, oldText, newText);
  switch (result.class) {
    case 'candidates':
      return { issues: 'content-not-found:candidates', replace: true, extra: result.report ?? '' };
    case 'too-large':
      return { issues: 'too-large', replace: true, extra: result.report ?? '' };
    case 'no-match':
      return result.report
        ? { issues: 'content-not-found:no-match', replace: false, extra: result.report }
        : null;
    case 'duplicates':
      return category === 'content-not-unique'
        ? { issues: 'content-not-unique:listed', replace: false, extra: result.report ?? '' }
        : null;
    default:
      return null; // none / rewrite — the built-in (re)handles it
  }
}

/**
 * Register the three hooks. `opts.enabled` gates all three at runtime so the
 * extension can be registered unconditionally; `opts.logPath` overrides the
 * default `~/.pi/agent/tool-repair.jsonl` (used by tests).
 * `opts.editFallbackEnabled` (strict: only `true` activates) gates the
 * fuzzy/nearest-match edit fallback (whitespace-drift `oldText` rewrite on
 * `message_end`, candidate/duplicate coaching on `tool_result`) — off by
 * default here so callers that don't know about it keep today's behavior
 * byte-identical; `src/index.ts` plumbs the `henyo.editFallback` setting.
 * The `message_end` and `tool_result` handlers are async (file reads via
 * `node:fs/promises`; `ExtensionHandler` accepts `Promise<R | void>`).
 */
export function toolRepairExtension(
  pi: ExtensionAPI,
  opts: { enabled: boolean; logPath?: string; editFallbackEnabled?: boolean },
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

  // toolCallId → per-edit rewrite records (cap PENDING_REWRITE_CAP, FIFO).
  const pendingRewrites = new Map<string, PendingRewrite[]>();

  // Hook 1 (O1): repair — hoist nested `path` before execution; when
  // `editFallbackEnabled`, also rewrite whitespace-drifted `oldText` to the
  // file's exact bytes (rule `whitespace-normalize-oldtext`) so the
  // built-in's exact match succeeds. Async (file reads via node:fs/promises).
  pi.on('message_end', async (event, ctx) => {
    if (!opts.enabled) return undefined;
    const message = event.message;
    if (message.role !== 'assistant') return undefined;
    const content = message.content;
    if (!Array.isArray(content)) return undefined;

    let changed = false;
    const newContent = await Promise.all(
      content.map(async (entry) => {
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
        // Fuzzy-edit fallback (AFTER the shape rules — normalize needs the
        // final shape): rewrite whitespace-drifted oldText entries in place.
        const rewrites = opts.editFallbackEnabled
          ? await applyEditFallback(
              args,
              entry.id,
              ctx.cwd,
              ctx.model?.id,
              pendingRewrites,
              appendLog,
            )
          : 0;
        if (rules.length > 0 || rewrites > 0) {
          changed = true;
          if (rules.length > 0) {
            appendLog({
              ts: new Date().toISOString(),
              tool: 'edit',
              model: ctx.model?.id,
              outcome: 'fixed',
              rules,
              fingerprint: editLocationFingerprint(args) ?? shapeFingerprint('edit', args),
            });
          }
          return { ...entry, arguments: args };
        }
        return entry;
      }),
    );

    if (!changed) return undefined;
    return { message: { ...message, content: newContent } };
  });

  // Hook 2 (O3): coaching — (a) unknown-tool errors get the available tool
  // list (never remapped — plan assumption 6); (b) validation failures on
  // any tool, both pi error signatures (`Validation failed for tool "X"`
  // and the older `Invalid input for tool "X"`) get a schema hint. edit gets
  // the specific line; every other tool gets the generic one.
  pi.on('tool_result', async (event, ctx) => {
    if (!opts.enabled) return undefined;

    // Telemetry v2 denominator: every successful `edit` result logs exactly
    // one `ok` record (repaired by message_end or not — the denominator is
    // all successful edits), so error rates are computable from the log
    // alone. Edit-only by plan assumption A1.
    if (event.toolName === 'edit' && !event.isError) {
      appendLog({
        ts: new Date().toISOString(),
        tool: 'edit',
        model: ctx.model?.id,
        outcome: 'ok',
        fingerprint: editLocationFingerprint(event.input) ?? shapeFingerprint('edit', event.input),
      });
    }

    // Fuzzy-edit fallback correlation (plan step 3.2): a successful result
    // consumes the pending rewrite records and logs `applied`; a failed call
    // consumes them WITHOUT logging (the built-in apply is atomic — first
    // failing edit throws before any write, so no partial state) and falls
    // through to the coaching below, which may be upgraded to the full
    // candidate/duplicate report.
    if (opts.editFallbackEnabled && event.toolName === 'edit') {
      const pending = pendingRewrites.get(event.toolCallId);
      if (pending) {
        pendingRewrites.delete(event.toolCallId);
        if (!event.isError) {
          const timestamp = new Date().toISOString();
          const fingerprint =
            editLocationFingerprint(event.input) ?? shapeFingerprint('edit', event.input);
          for (const p of pending) {
            appendLog({
              ts: timestamp,
              tool: 'edit',
              model: ctx.model?.id,
              outcome: 'applied',
              rules: ['whitespace-normalize-oldtext'],
              fingerprint,
              toolCallId: event.toolCallId,
              editIndex: p.editIndex,
              lineRange: p.lineRange,
              fileLines: p.fileLines,
              oldTextLines: p.oldTextLines,
              sha12: p.sha12,
            });
          }
          return undefined; // success — the result content is untouched
        }
        // failed call — fall through to the coaching below
      }
    }

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
        // Upgrade the one-line hint to the full report when the feature is
        // on and a report qualifies (assumption 11: nothing qualifies → the
        // existing one-line hint stays).
        let note = `Henyo note: ${rule.line}`;
        let issues = rule.category;
        if (
          opts.editFallbackEnabled &&
          (rule.category === 'content-not-found' || rule.category === 'content-not-unique')
        ) {
          const enhancement = await classifyContentError(
            rule.category,
            firstLine,
            event.input,
            ctx.cwd,
          );
          if (enhancement) {
            note = enhancement.replace
              ? `Henyo note: ${enhancement.extra}`
              : `Henyo note: ${rule.line}\n${enhancement.extra}`;
            issues = enhancement.issues;
          }
        }
        appendLog({
          ts: new Date().toISOString(),
          tool: 'edit',
          model: ctx.model?.id,
          outcome: 'failed',
          issues,
          fingerprint: editLocationFingerprint(input) ?? shapeFingerprint('edit', input),
        });

        return {
          content: [{ type: 'text', text: `${originalText}\n\n${note}` }],
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
      fingerprint:
        event.toolName === 'edit'
          ? (editLocationFingerprint(input) ?? shapeFingerprint(event.toolName, input))
          : shapeFingerprint(event.toolName, input),
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
