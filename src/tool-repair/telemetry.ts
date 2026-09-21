import { readFile } from 'node:fs/promises';
import {
  classifyEdit,
  normalizeToLF,
  resolveEditPath,
  splitLinesWithEndings,
} from '../edit-fallback.js';
import { editLocationFingerprint, sha12, shapeFingerprint } from './fingerprint.js';

export interface LogRecord {
  ts: string;
  tool: string;
  model?: string;
  outcome: 'fixed' | 'failed' | 'applied' | 'ok' | 'recovered';
  rules?: string[];
  issues?: string;
  // Original built-in error category for content-mismatch `failed` records
  // — `issues !== category` signals an upgraded subcategory (e.g.
  // `content-not-found:candidates`); the mislabel check is `category` vs
  // the `issues` prefix. Only content-mismatch `failed` records carry it;
  // `unknown-tool` and validation-class records are untouched (their
  // `issues` is the first-class classification).
  category?: string;
  fingerprint?: string;
  // Telemetry v2 recovery fields — `recoveredBy` is the toolCallId of the
  // successful edit that closed the failure; `afterMs` is the time between
  // the failure and the recovery.
  // Telemetry v2: `recovered` closes open failures; `ok` is the denominator
  // (step 2); `emission` tags validation-failure payloads (step 4, plan A4).
  // Telemetry v2: `retriedVerbatim` (assumption 6, plan
  // tool-repair-edit-usage-improvements) — set on a `failed` `edit` record
  // when a failure with the same `fingerprint` is still open for the same
  // file and no successful `read` of that file happened after it (reads
  // reset the flag; recovery closes the open-failure list).
  emission?: string;
  retriedVerbatim?: boolean;
  recoveredBy?: string;
  afterMs?: number;
  // Fuzzy-edit fallback records (plan assumption 6) — argument values never
  // reach the log; `sha12` is the only trace of the original oldText.
  toolCallId?: string;
  editIndex?: number;
  lineRange?: { startLine: number; endLine: number };
  fileLines?: number;
  oldTextLines?: number;
  sha12?: string;
}

export const PENDING_REWRITE_CAP = 100;

export interface PendingRewrite {
  path: string;
  editIndex: number;
  lineRange: { startLine: number; endLine: number };
  fileLines: number;
  oldTextLines: number;
  sha12: string;
}

/** Telemetry v2: an open (not yet recovered) edit failure — recovery state (plan A2/A5). */
export interface OpenFailure {
  fingerprint: string;
  toolCallId: string;
  ts: string;
  issues: string;
  model: string | undefined;
}

/** Per-file cap on open failures (FIFO, drop oldest) — implementation constant. */
export const OPEN_FAILURES_CAP = 8;

/** Insert a pending rewrite record; evict the oldest toolCallIds FIFO past the cap. */
export function rememberRewrite(
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
export async function applyEditFallback(
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
  // First pass: decide + apply rewrites (independent per edit — classifyEdit
  // only reads the file, not the args). All mutations land BEFORE the
  // fingerprint is computed, so the `fixed` records carry the same location
  // fingerprint as the paired `applied`/`ok`/`failed` records (A1, plan
  // tool-repair-a1a2-coherence) — a pre-mutation fingerprint is NOT
  // whitespace-invariant: normalizeForFingerprint keeps one leading space per
  // indented line. `shapeFingerprint` covers args without a resolvable location.
  interface PlannedRewrite {
    editIndex: number;
    oldText: string;
    rewrittenOldText: string;
    lineRange: { startLine: number; endLine: number };
  }
  const planned: PlannedRewrite[] = [];
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
    planned.push({
      editIndex: i,
      oldText,
      rewrittenOldText: result.rewrittenOldText,
      lineRange: result.lineRange,
    });
  }
  if (planned.length === 0) return 0;
  const fingerprint = editLocationFingerprint(args) ?? shapeFingerprint('edit', args);
  let count = 0;
  for (const pw of planned) {
    const { editIndex: i, oldText, lineRange } = pw;
    const oldTextLines = splitLinesWithEndings(normalizeToLF(oldText)).length;
    const record: PendingRewrite = {
      path,
      editIndex: i,
      lineRange,
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
      lineRange,
      fileLines,
      oldTextLines,
      sha12: record.sha12,
    });
    count += 1;
  }
  return count;
}

/** Upgrade produced for a content-mismatch failure (plan step 3.2). */
export interface ContentErrorEnhancement {
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
 * e.g. the file changed since the model's read — or category/class mismatch,
 * e.g. a not-unique error whose current-file class is `candidates`/`no-match`/
 * `too-large`, or a not-found error whose class is `duplicates` — the file
 * changed after the model's read; the one-line hint suffices in both
 * directions) so the existing one-line hint stays untouched
 * (assumption 11: no behavior regression).
 */
export async function classifyContentError(
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
      return category === 'content-not-found'
        ? { issues: 'content-not-found:candidates', replace: true, extra: result.report ?? '' }
        : null;
    case 'too-large':
      return category === 'content-not-found'
        ? { issues: 'too-large', replace: true, extra: result.report ?? '' }
        : null;
    case 'no-match':
      return category === 'content-not-found' && result.report
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
