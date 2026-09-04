/**
 * Fuzzy/nearest-match edit fallback — pure matching + reporting core.
 *
 * What it does (plan: fuzzy-edit-fallback, research: pi-qwen-edit-failures
 * option 2, fix #2): the built-in `edit` tool fails with a bare content
 * mismatch when `edits[].oldText` drifts from the file by whitespace or
 * indentation (68% of measured edit failures, 2026-09 q35b session study).
 * This module gives the tool-repair layer two capabilities:
 *
 * 1. PRE-EXECUTION REWRITE (stage 1) — when the built-in matcher would FAIL
 *    (exact + typography-fuzzy, predicate ported from pi's internal
 *    `edit-diff.js`) but a UNIQUE whitespace-normalized 1:1 line match
 *    exists, the file's exact bytes for the matched region are returned so
 *    the hook can replace `oldText` before execution. The built-in then
 *    applies the edit with its exact-match path.
 * 2. NEAREST-MATCH REPORTING (stages 2–3) — when nothing can be applied
 *    safely, candidate line ranges with unified diffs (not-found) or
 *    occurrence line numbers (duplicates) are returned so the hook can
 *    coach the model to recover in one retry instead of ~3.6 blind turns.
 *
 * Safety model (plan assumption 4): only unique whitespace-normalized 1:1
 * line matches get rewritten pre-execution; ambiguous / multi-occurrence /
 * non-1:1 cases are report-only (never applied). `newText` is never
 * modified. `oldText === newText` (no-op attempt) is never rewritten — the
 * built-in keeps its own error.
 *
 * Purity: strings in, strings out — no pi imports, no fs. File IO, path
 * resolution, and hook wiring live in `tool-repair.ts` (Step 3).
 */

export const version = '0.1.0';
