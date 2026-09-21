export const COACHING_LINE =
  'Henyo note: for the edit tool, put `path` at the top level next to `edits` (not inside an edit object), and keep `edits` an array of { oldText, newText } objects.';

export const PROMPT_LINE =
  'For the `edit` tool, put `path` at the top level of the arguments, next to `edits` — not inside individual edit objects.';

export const READ_BEFORE_EDIT_LINE =
  'If you have not read the file this turn (or it may have changed since your last read), read it immediately before calling edit, and copy edits[].oldText verbatim from that fresh read.';

export const TRUST_RESULT_LINE =
  'If an `edit` or `write` call reports success, trust that result — do not re-read the file to verify its integrity because of stray characters (e.g. `\\r`) in the transcript echo of your own call. The tool result is authoritative; that echo is a display artifact.';

export const NO_BYPASS_LINE =
  'Edit existing files only with the `edit` tool — never via `sed`/`awk`/`echo` in bash, and never via `write` re-emitting the whole file.';

export const GENERIC_COACHING_LINE =
  "Henyo note: the arguments must match the tool's schema exactly — required fields go at the top level of the arguments. Re-emit the call with the complete argument object.";

export const UNKNOWN_TOOL_SIGNATURE = /^Tool\s+"?[A-Za-z0-9_.-]*"? not found$/;

/**
 * Coaching for `edit` content-mismatch errors — the dominant failure class
 * for the served Qwen models (77% of observed edit errors, 2026-09-02
 * session-failure analysis). Ordered, first match on the error's first line
 * wins. `line` is raw — the hook prefixes `Henyo note: `.
 */
export const CONTENT_ERROR_RULES: { re: RegExp; category: string; line: string }[] = [
  {
    re: /Could not find (edits\[\d+\] in|the exact text in)/,
    category: 'content-not-found',
    line: 'Re-read the file now (it may have changed since your last read) and copy oldText verbatim from the fresh read, including exact whitespace and newlines. Do not re-emit an oldText that has already failed — it will fail again.',
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

/**
 * Fallback for `getActiveTools()` when it throws (telemetry must not break a run).
 * Keep this list in sync with pi's built-in tools when they change — stale text
 * degrades the unknown-tool coaching message shown to the model.
 */
export const FALLBACK_TOOL_LIST = 'bash, read, edit, write, grep, find, ls';
