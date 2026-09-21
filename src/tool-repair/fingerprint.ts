import { createHash } from 'node:crypto';
import { basename } from 'node:path';

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
export function shapeFingerprint(tool: string, input: unknown): string {
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

/** Emission classes for validation-failure `edits` payloads (telemetry v2, plan A4). */
export type EmissionClass = 'truncated' | 'glued' | 'shape-quirk';

/** Escape-aware count of `"` characters (a `\` before a quote skips it). */
function countUnescapedQuotes(s: string): number {
  let count = 0;
  let escaped = false;
  for (const c of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') count += 1;
  }
  return count;
}

/**
 * Classify a validation-failed `edit` `edits` payload by emission shape
 * (telemetry v2, plan A4) — separates truncated args (G3) from vLLM
 * multi-call glue (G5) from ordinary shape quirks, so both gap frequencies
 * are measurable from the log alone. Heuristic tag only — NEVER mutates
 * arguments. Returns `undefined` for non-`edit` tools, missing `edits`, and
 * array shapes with no recognizable defect (callers omit the `emission`
 * field).
 *
 * Array `edits`: last entry an object with `oldText` but no string
 * `newText` while all earlier entries are complete → `truncated`; any
 * entry a string → `shape-quirk`; else `undefined`.
 * String `edits` (trimmed): parseable JSON → `shape-quirk`; odd unescaped
 * `"` count OR does not end in `"` / `]` / `}` → `truncated`; ≥2
 * `"oldText"` + `}{` (glue) → `glued`; else `shape-quirk` (closed
 * unparseable debris, e.g. tag bleed).
 */
export function classifyEmission(toolName: string, input: unknown): EmissionClass | undefined {
  if (toolName !== 'edit') return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const edits = (input as Record<string, unknown>).edits;
  if (edits === undefined) return undefined;
  if (Array.isArray(edits)) {
    const entries = edits as unknown[];
    const last = entries[entries.length - 1];
    const lastIsIncomplete =
      last !== null &&
      typeof last === 'object' &&
      !Array.isArray(last) &&
      typeof (last as Record<string, unknown>).oldText === 'string' &&
      typeof (last as Record<string, unknown>).newText !== 'string';
    const earlierComplete = entries
      .slice(0, -1)
      .every(
        (e) =>
          e !== null &&
          typeof e === 'object' &&
          !Array.isArray(e) &&
          typeof (e as Record<string, unknown>).oldText === 'string' &&
          typeof (e as Record<string, unknown>).newText === 'string',
      );
    if (lastIsIncomplete && earlierComplete) return 'truncated';
    if (entries.some((e) => typeof e === 'string')) return 'shape-quirk';
    return undefined;
  }
  if (typeof edits !== 'string') return undefined;
  const s = edits.trim();
  try {
    JSON.parse(s);
    return 'shape-quirk';
  } catch {
    // unparseable — fall through to the heuristics
  }
  if (countUnescapedQuotes(s) % 2 === 1 || !/["\]}]$/.test(s)) return 'truncated';
  if ((s.match(/"oldText"/g) ?? []).length >= 2 && /}\s*\{/.test(s)) return 'glued';
  return 'shape-quirk';
}

/**
 * Shape diagnostics for the `issues` field of `failed` records.
 * Sorted keys for all tools (the old edit format was unsorted); a
 * tool-agnostic `;edits=<type>` suffix is appended whenever the input
 * object has an `edits` field (plan decision 4).
 */
export function shapeDiagnostics(_tool: string, input: unknown): string {
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

/** First 12 hex chars of SHA-256 — argument values never reach the log. */
export function sha12(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}
