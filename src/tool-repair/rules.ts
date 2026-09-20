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
