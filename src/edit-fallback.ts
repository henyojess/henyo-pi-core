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

import { Buffer } from 'node:buffer';

import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';

export const version = '0.1.0';

/** Files larger than this (UTF-8 bytes) get no rewrite and no candidate scan (plan assumption 10). */
const SIZE_GUARD_BYTES = 1024 * 1024;

/** A not-found edit with a window this similar gets a "read that region first" hint (below the 0.8 report floor). */
const NEAR_MISS_RATIO = 0.6;

// ────────────────────────────────────────────────────────────────────────────
// Built-in predicate port — byte-for-byte from pi's internal
// dist/core/tools/edit-diff.js (pi 0.84.2; line refs recorded in the
// fuzzy-edit-fallback plan, Step 1.1). RE-RUN TESTS AFTER PI UPGRADES —
// if the built-in matcher changes, this port must be re-derived.
// ────────────────────────────────────────────────────────────────────────────

/** LF-normalize (built-in `normalizeToLF`, edit-diff.js L17). */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Strip UTF-8 BOM if present (built-in `stripBom`/`splitBom`, edit-diff.js
 * L177 / utils/text.js). Ported in addition to the plan's four port targets
 * because the built-in strips the BOM before matching — without it the
 * predicate diverges on BOM files whose first line matches.
 */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}

/**
 * Normalize text for typography-fuzzy matching (built-in
 * `normalizeForFuzzyMatch`, edit-diff.js L30): NFKC → per-line trimEnd →
 * smart quotes → dashes/minus → special spaces.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize('NFKC')
      // Strip trailing whitespace per line
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      // Smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens → -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      // Special spaces → regular space
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
  );
}

/**
 * Find oldText in content, exact match first, then fuzzy (built-in
 * `fuzzyFindText`, edit-diff.js L140). All calls operate in LF-normalized
 * space (the built-in normalizes content and each edit's oldText before
 * matching).
 */
export function fuzzyFindText(content: string, oldText: string): { found: boolean } {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return { found: fuzzyContent.indexOf(fuzzyOldText) !== -1 };
}

/**
 * Count occurrences in typography-fuzzy space (built-in `countOccurrences`,
 * edit-diff.js L180).
 */
export function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

/**
 * The exact gate for intervention: would the built-in matcher succeed on
 * this (content, oldText)? Mirrors the built-in execution path —
 * `stripBom` → `normalizeToLF` → `fuzzyFindText` (edit.js: `splitBom` →
 * `normalizeToLF` → `applyEditsToNormalizedContent` → per-edit
 * `fuzzyFindText`). `true` → this module must NOT intervene (zero
 * behavioral change for currently-working edits).
 */
export function builtinWouldMatch(content: string, oldText: string): boolean {
  const { text } = stripBom(content);
  return fuzzyFindText(normalizeToLF(text), normalizeToLF(oldText)).found;
}

// ────────────────────────────────────────────────────────────────────────────
// Stage 1 — whitespace-normalized matching (rewrite)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Whitespace-normalize one line: trim + collapse internal whitespace runs to
 * a single space (blank lines stay empty — line count is always preserved).
 * Unicode-aware: JS `\s` covers the unicode space set.
 */
export function normWs(text: string): string {
  return normalizeToLF(text)
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join('\n');
}

/**
 * Whitespace-normalize one FILE LINE (a `splitLinesWithEndings` element —
 * carries a trailing `\n` except for the final line). The terminator is
 * stripped first: normalizing a line WITH its `\n` would keep the newline in
 * the normalized string (split → ["line", ""]) and break last-line /
 * blank-line comparisons.
 */
function normLine(line: string): string {
  // Fast path for a single line: for a `\n`-free string, normWs reduces to
  // trim + collapse (normalizeToLF/split/join are no-ops). Lines here are
  // `splitLinesWithEndings` elements — the terminator (if any) is stripped
  // first, since normalizing WITH its `\n` would keep the newline in the
  // normalized string (split → ["line", ""]) and break last-line /
  // blank-line comparisons.
  return normSingle(line.replace(/\n$/, ''));
}

/** Whitespace-normalize a single `\n`-free line (fast path; ≡ normWs). */
function normSingle(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/** Split into lines KEEPING line endings (ported from built-in `splitLinesWithEndings`). */
export function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/**
 * Contiguous 1:1 line match search over whitespace-normalized lines.
 * `fileLines`/`oldLines` are raw LF-space lines (BOM-stripped); each side is
 * normalized line-by-line with `normWs`. Returns 0-based start indices of
 * every window whose length equals `oldLines.length` and whose normalized
 * lines equal the normalized oldText lines. O(n·m) naive — bounded by the
 * 1 MB size guard.
 */
export function findNormalizedMatches(fileLines: string[], oldLines: string[]): number[] {
  const m = oldLines.length;
  if (m === 0 || fileLines.length < m) return [];
  const fileNorm = fileLines.map(normLine);
  const oldNorm = oldLines.map(normLine);
  const starts: number[] = [];
  for (let i = 0; i + m <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < m; k++) {
      if (fileNorm[i + k] !== oldNorm[k]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  return starts;
}

/**
 * Resolve a pre-execution `oldText` rewrite (stage 1, plan assumption 4).
 *
 * Returns the file's EXACT bytes for the matched region (original line
 * endings preserved — CRLF files get CRLF bytes; the built-in
 * `normalizeToLF`s the rewritten oldText before matching, so it applies
 * through its exact-match path) iff ALL hold:
 * - the built-in would FAIL on (content, oldText) — working edits are never
 *   touched,
 * - exactly one whitespace-normalized 1:1 line match exists,
 * - `oldText !== newText` (no-op attempts keep the built-in error).
 *
 * BOM: never included in the rewritten text (the built-in matches against
 * BOM-stripped content; a BOM inside oldText would break both its exact and
 * fuzzy paths). A lone-`\r` (old-Mac) file — where raw and LF line counts
 * differ — gets no rewrite (the 1:1 line mapping the rebuild relies on is
 * not sound there); the caller falls through to report-only classes.
 */
export function resolveRewrite(
  content: string,
  oldText: string,
  newText: string,
): { rewrittenOldText: string; lineRange: { startLine: number; endLine: number } } | null {
  if (typeof content !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string') {
    return null;
  }
  if (builtinWouldMatch(content, oldText)) return null;
  const { text } = stripBom(content);
  return resolveRewriteCore(text, splitLinesWithEndings(normalizeToLF(text)), oldText, newText);
}

/**
 * Stage-1 core — same guards/semantics as `resolveRewrite` except the caller
 * has already established `builtinWouldMatch === false` and passes the
 * pre-split LF lines (avoids a redundant normalize/split + predicate round).
 */
function resolveRewriteCore(
  rawText: string, // BOM-stripped original content
  fileLines: string[], // splitLinesWithEndings(normalizeToLF(rawText))
  oldText: string,
  newText: string,
): { rewrittenOldText: string; lineRange: { startLine: number; endLine: number } } | null {
  if (oldText === newText) return null;
  const rawLines = splitLinesWithEndings(rawText);
  if (rawLines.length !== fileLines.length) return null; // lone-\r file — no sound mapping
  const oldLines = splitLinesWithEndings(normalizeToLF(oldText));
  const m = oldLines.length;
  if (m === 0 || fileLines.length < m) return null;
  const starts = findNormalizedMatches(fileLines, oldLines);
  if (starts.length !== 1) return null;
  const start = starts[0];
  return {
    rewrittenOldText: rawLines.slice(start, start + m).join(''),
    lineRange: { startLine: start + 1, endLine: start + m },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Stage 2 — nearest-match candidates
// ────────────────────────────────────────────────────────────────────────────

interface MatchBlock {
  a: number;
  b: number;
  size: number;
}

/**
 * Classic difflib `SequenceMatcher.ratio` over line arrays
 * (ratio = 2M/T, M = total size of longest matching blocks).
 * `[assumption]:` autojunk deliberately omitted (standard for JS ports and
 * for short windows; it only degrades matching on pathological
 * repeated-line files).
 */
export function lineRatio(a: string[], b: string[]): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const positions = b2j.get(b[j]);
    if (positions) positions.push(j);
    else b2j.set(b[j], [j]);
  }

  const findLongest = (alo: number, ahi: number, blo: number, bhi: number): MatchBlock | null => {
    let bestI = alo;
    let bestJ = blo;
    let bestSize = 0;
    const matching = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) continue;
        const k = (matching.get(j - 1) ?? 0) + 1;
        if (k > bestSize) {
          matching.set(j, k);
          bestI = i + 1 - k;
          bestJ = j + 1 - k;
          bestSize = k;
        }
      }
    }
    if (bestSize > 0) {
      // Extend the best match found (built-in difflib tail).
      while (alo < bestI && blo < bestJ && a[bestI - 1] === b[bestJ - 1]) {
        bestI--;
        bestJ--;
        bestSize++;
      }
      while (
        bestI + bestSize < ahi &&
        bestJ + bestSize < bhi &&
        a[bestI + bestSize] === b[bestJ + bestSize]
      ) {
        bestSize++;
      }
    }
    return bestSize === 0 ? null : { a: bestI, b: bestJ, size: bestSize };
  };

  // difflib's get_matching_blocks recursion: count the longest match at each
  // level, then recurse on the (unmatched) left and right sub-ranges.
  let m = 0;
  const walk = (alo: number, ahi: number, blo: number, bhi: number): void => {
    const block = findLongest(alo, ahi, blo, bhi);
    if (!block) return;
    const a = block.a;
    const b = block.b;
    m += block.size;
    if (a > alo || b > blo) walk(alo, a, blo, b);
    if (a + block.size < ahi || b + block.size < bhi) {
      walk(a + block.size, ahi, b + block.size, bhi);
    }
  };
  walk(0, a.length, 0, b.length);
  return (2 * m) / total;
}

export interface Candidate {
  /** 1-based start line of the window in the file. */
  startLine: number;
  /** 1-based end line of the window in the file (inclusive). */
  endLine: number;
  /** lineRatio of the window against the oldText lines (0..1). */
  ratio: number;
  /** File bytes of the window (LF-space lines, endings kept) — for the diff. */
  regionText: string;
}

export interface CandidateOptions {
  /** Minimum ratio for a window to qualify (default 0.8). */
  minRatio?: number;
  /** Minimum gap below the best ratio for a second candidate to count (default 0.03). */
  maxRatioGap?: number;
  /** Maximum candidates returned (default 2). */
  topK?: number;
}

/**
 * Slide line-count windows (deltas −1/0/+1 over the oldText line count) over
 * the file; rank windows by `lineRatio` (whitespace-normalized lines);
 * return the best up to `topK` with ratio ≥ `minRatio`, skipping windows
 * that overlap an already-accepted one (same region, different delta) and
 * windows within `maxRatioGap` of the best (not a distinct alternative).
 *
 * Performance: a multiset-intersection upper bound on the matching-block
 * total prunes every window whose ratio is provably below `minRatio` in
 * O(window length) before the O(m²) ratio runs — 5k-line files classify in
 * well under the 50 ms budget. `fileLines`/`oldLines` are raw LF-space
 * lines (BOM-stripped).
 */
export function nearestCandidates(
  fileLines: string[],
  oldLines: string[],
  opts: CandidateOptions = {},
): Candidate[] {
  const minRatio = opts.minRatio ?? 0.8;
  const maxRatioGap = opts.maxRatioGap ?? 0.03;
  const topK = opts.topK ?? 2;
  const n = fileLines.length;
  const m = oldLines.length;
  if (n === 0 || m === 0) return [];

  const fileText = fileLines.map((l) => l.replace(/\n$/, ''));
  const oldTextArr = oldLines.map((l) => l.replace(/\n$/, ''));
  const fileNorm = fileText.map(normSingle);
  const oldNorm = oldTextArr.map(normSingle);
  const oldCounts = new Map<string, number>();
  for (const l of oldNorm) oldCounts.set(l, (oldCounts.get(l) ?? 0) + 1);

  // Exact ratio over whitespace-NORMALIZED lines — `[assumption]:` the plan's
  // "line-level SequenceMatcher.ratio over the window and oldText's lines"
  // reads as raw lines, but raw ratios score pure whitespace drift (the
  // drift class this feature exists for) at ~0, so the plan's own "ambiguous
  // blocks with drift → candidates report" test bullet could never pass.
  // normWs lines measure region-to-intent similarity; the rendered diff
  // below still shows RAW bytes. The UB above is exact in this same space.
  const score: (start: number, len: number) => number = (start, len) =>
    lineRatio(fileNorm.slice(start, start + len), oldNorm);

  const windows: { start: number; len: number; ratio: number }[] = [];
  const deltaLens: number[] = [];
  for (const delta of [-1, 0, 1]) {
    const len = m + delta;
    if (len >= 1 && len <= n) deltaLens.push(len);
  }
  for (const len of deltaLens) {
    // Sliding multiset-intersection upper bound on M (see docstring).
    const winCounts = new Map<string, number>();
    let ub = 0;
    const addLine = (line: string): void => {
      const c = (winCounts.get(line) ?? 0) + 1;
      winCounts.set(line, c);
      const oc = oldCounts.get(line) ?? 0;
      if (c <= oc) ub += 1; // a newly-paired line (previous count < oc)
    };
    const removeLine = (line: string): void => {
      const c = (winCounts.get(line) ?? 0) - 1;
      if (c <= 0) winCounts.delete(line);
      else winCounts.set(line, c);
      const oc = oldCounts.get(line) ?? 0;
      if (c < oc && c >= 0) ub -= 1; // a line that was paired
    };
    for (let i = 0; i < len; i++) addLine(fileNorm[i]);
    for (let start = 0; start + len <= n; start++) {
      if ((2 * ub) / (len + m) >= minRatio) {
        windows.push({ start, len, ratio: score(start, len) });
      }
      if (start + len < n) {
        removeLine(fileNorm[start]);
        addLine(fileNorm[start + len]);
      }
    }
  }

  // 2. Filter — `[assumption]:` the plan says "dedupe overlapping windows
  // (same startLine)"; a literal same-startLine dedupe is not enough because
  // sliding ±1 windows around a perfect region form a shift-tail cluster
  // (starts 1..k all score ~1.0 − ε) that would pollute the report. So:
  // sort by (ratio desc, start asc), then suppress any candidate that
  // (a) overlaps ANY higher-or-equal-ratio window — kept or not: a shifted
  //     variant of a region whose best window already failed the gap filter
  //     must not slip through in its place (this subsumes same-startLine
  //     dedupe and keeps the best window per region), or
  // (b) is within maxRatioGap of ANY strictly better kept candidate.
  // Pass 1 marks each window "region-best" = it overlaps no region-best
  // higher-or-equal-ratio window (a non-representative filler-bridging
  // window must not suppress a whole second region); pass 2 keeps
  // region-best windows that are not within maxRatioGap of a kept one.
  // The region-best scan skips windows too far left to overlap (h.len ≤ m + 1)
  // and stops at the first overlap. Worst case (pathological all-identical-line
  // files) is O(k²) window-pair checks — bounded by the 1 MB guard; realistic
  // code files yield small k.
  const sorted = windows
    .filter((w) => w.ratio >= minRatio)
    .sort((x, y) => y.ratio - x.ratio || x.start - y.start);
  const overlaps = (
    a: { start: number; len: number },
    b: { start: number; len: number },
  ): boolean => a.start <= b.start + b.len - 1 && b.start <= a.start + a.len - 1;
  const regionBest: boolean[] = new Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    let dominated = false;
    for (let j = 0; j < i; j++) {
      const h = sorted[j];
      if (!regionBest[j]) continue; // only representatives may dominate
      if (h.start < w.start - m) continue; // too far left to overlap (h.len ≤ m + 1)
      if (overlaps(h, w)) {
        dominated = true;
        break;
      }
    }
    regionBest[i] = !dominated;
  }
  const picked: { start: number; len: number; ratio: number }[] = [];
  for (let i = 0; i < sorted.length && picked.length < topK; i++) {
    if (!regionBest[i]) continue;
    const w = sorted[i];
    const withinGap = picked.some((p) => p.ratio > w.ratio && p.ratio - w.ratio < maxRatioGap);
    if (!withinGap) picked.push(w);
  }
  return picked.map((p) => ({
    startLine: p.start + 1,
    endLine: p.start + p.len,
    ratio: p.ratio,
    regionText: fileLines.slice(p.start, p.start + p.len).join(''),
  }));
}

/**
 * Render the nearest-match report (plan assumption 11: the hook prefixes
 * `Henyo note: `). Per candidate: 1-based line range, ratio (3 dp), unified
 * diff of the model oldText → file region (`createTwoFilesPatch`, context
 * 3, headers suppressed like the built-in's `generateUnifiedPatch`);
 * closing guidance for the best candidate.
 */
export function formatCandidateReport(
  path: string,
  candidates: Candidate[],
  oldText: string,
): string {
  const parts: string[] = [];
  for (const c of candidates) {
    const patch = createTwoFilesPatch(
      path,
      path,
      normalizeToLF(oldText),
      normalizeToLF(c.regionText),
      undefined,
      undefined,
      { context: 3, headerOptions: FILE_HEADERS_ONLY },
    );
    parts.push(
      `Nearest match (lines ${c.startLine}–${c.endLine}, ratio ${c.ratio.toFixed(3)}):` +
        `\n${patch.trimEnd()}`,
    );
  }
  const best = candidates[0];
  const guidance =
    `Re-issue the edit with the exact file text (lines ${best.startLine}–${best.endLine}) ` +
    `or read the file at offset ${best.startLine}.`;
  return parts.length > 0 ? `${parts.join('\n\n')}\n${guidance}` : guidance;
}

// ────────────────────────────────────────────────────────────────────────────
// Stage 3 — duplicate listing
// ────────────────────────────────────────────────────────────────────────────

/** One occurrence: 1-based start line + 20-char context snippet. */
export interface Occurrence {
  line: number;
  snippet20: string;
}

/**
 * Locate every occurrence of `oldLines` in `fileLines` (raw LF-space lines,
 * BOM-stripped). Cascade: (1) whitespace-normalized lines; (2) if that finds
 * nothing — typography-fuzzy lines (the built-in's own match space, so
 * smart-quote/dash duplicates still resolve); (3) raw lines. Returns at most
 * `max` occurrences, each with the 1-based start line and a 20-char snippet
 * of the file's raw line.
 */
export function listOccurrences(fileLines: string[], oldLines: string[], max = 10): Occurrence[] {
  const m = oldLines.length;
  if (m === 0 || fileLines.length < m) return [];
  const fileText = fileLines.map((l) => l.replace(/\n$/, ''));
  const oldTextArr = oldLines.map((l) => l.replace(/\n$/, ''));
  const searches: string[][] = [
    fileText.map(normSingle),
    fileText.map(normalizeForFuzzyMatch),
    fileText, // raw content (terminator-stripped, so the final line matches)
  ];
  const olds: string[][] = [
    oldTextArr.map(normSingle),
    oldTextArr.map(normalizeForFuzzyMatch),
    oldTextArr,
  ];
  for (let s = 0; s < searches.length; s++) {
    const starts: number[] = [];
    for (let i = 0; i + m <= fileLines.length; i++) {
      let ok = true;
      for (let k = 0; k < m; k++) {
        if (searches[s][i + k] !== olds[s][k]) {
          ok = false;
          break;
        }
      }
      if (ok) starts.push(i);
    }
    if (starts.length > 0) {
      return starts.slice(0, max).map((i) => {
        const rawLine = fileText[i];
        return {
          line: i + 1,
          snippet20: rawLine.slice(0, 20) + (rawLine.length > 20 ? '…' : ''),
        };
      });
    }
  }
  return [];
}

/** Render the duplicate report (hook prefixes `Henyo note: `). */
export function formatDuplicateReport(
  path: string,
  occurrences: Occurrence[],
  count: number,
): string {
  if (occurrences.length === 0) {
    return (
      `The text occurs ${count} times in ${path}, but line numbers could not be resolved ` +
      `(oldText may span the lines differently). Re-read the file and extend oldText ` +
      'with enough surrounding lines to be unique.'
    );
  }
  const lines = occurrences.map((o) => `  line ${o.line}: ${o.snippet20}`);
  return (
    `The text occurs ${count} times in ${path} (first ${occurrences.length} occurrences):` +
    `\n${lines.join('\n')}\nAdd more context to make oldText unique.`
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────────────────

export type EditFallbackClass =
  | 'none' // the built-in would handle this (or the edit is a no-op) — zero intervention
  | 'rewrite' // unique 1:1 normalized match — oldText rewritten pre-execution
  | 'candidates' // nearest-match report (not-found with qualifying windows)
  | 'duplicates' // occurrence line-number report
  | 'no-match' // nothing qualified (optional near-miss hint)
  | 'too-large'; // size guard (plan assumption 10)

export interface ClassifyResult {
  class: EditFallbackClass;
  /** File-exact bytes for the matched region (class = 'rewrite' only). */
  rewrittenOldText?: string;
  /** 1-based inclusive line range (rewrite + near-miss hint). */
  lineRange?: { startLine: number; endLine: number };
  /** Report body / hint for the hook to append (no `Henyo note:` prefix). */
  report?: string;
}

/**
 * Single entry point for the hooks (Step 3) and the corpus evaluation
 * (Step 5): classify an `edit` call's (content, oldText, newText) against
 * the built-in's semantics and produce at most one intervention.
 *
 * Decision order (plan 2.5, refined — `[assumption]:` plan step 1 says
 * "builtinWouldMatch true → none", but the 2.1 predicate is FOUND-only;
 * with it, a duplicate oldText (found ≥ 2 — the built-in fails it with a
 * not-unique error, so it is NOT a working edit) would mis-classify as
 * `none` and the duplicates branch could never fire. Step 1 therefore uses
 * the full built-in success gate: found AND unique. `builtinWouldMatch`
 * itself stays the found-only port.)
 * 0. empty oldText → `none` (the built-in has its own empty-text error)
 * 1. built-in would find the text: unique → `none` (working edit — never
 *    touched); >1 occurrences → `duplicates` (+ report)
 * 2. content > 1 MB → `too-large` (+ note; no rewrite, no scan)
 * 3. unique whitespace-normalized 1:1 match → `rewrite`
 *    (`oldText === newText` → `none`, plan assumption 4)
 * 4. candidates qualify → `candidates` (+ report)
 * 5. else → `no-match` (+ near-miss hint when the best window is ≥ 0.6
 *    similar; plain otherwise — the hook keeps the existing one-line hint)
 */
export function classifyEdit(
  _path: string,
  content: string,
  oldText: string,
  newText: string,
): ClassifyResult {
  if (typeof content !== 'string' || typeof oldText !== 'string' || typeof newText !== 'string') {
    return { class: 'none' };
  }
  if (oldText === '') {
    return { class: 'none' }; // built-in's empty-oldText error path — untouched
  }

  const { text } = stripBom(content);
  const lf = normalizeToLF(text);

  if (builtinWouldMatch(content, oldText)) {
    // Occurrences only matter on the found path — count them there.
    const occurrences = countOccurrences(lf, normalizeToLF(oldText));
    if (occurrences <= 1) {
      return { class: 'none' }; // the built-in applies this — zero intervention
    }
    const fileLines = splitLinesWithEndings(lf);
    const oldLines = splitLinesWithEndings(normalizeToLF(oldText));
    return {
      class: 'duplicates',
      report: formatDuplicateReport(_path, listOccurrences(fileLines, oldLines), occurrences),
    };
  }

  if (Buffer.byteLength(lf, 'utf8') > SIZE_GUARD_BYTES) {
    return {
      class: 'too-large',
      report:
        'File too large for nearest-match analysis. Re-read the file and copy oldText verbatim.',
    };
  }

  const fileLines = splitLinesWithEndings(lf);
  const oldLines = splitLinesWithEndings(normalizeToLF(oldText));

  // Stage 1 — rewrite (core shared with standalone resolveRewrite; the
  // builtin-fail check is already done above).
  const rewrite = resolveRewriteCore(text, fileLines, oldText, newText);
  if (rewrite) {
    return {
      class: 'rewrite',
      rewrittenOldText: rewrite.rewrittenOldText,
      lineRange: rewrite.lineRange,
    };
  }
  if (oldText === newText) {
    return { class: 'none' }; // no-op attempt — keep the built-in error (plan assumption 4)
  }

  // Stage 2 — nearest-match candidates. Single pass at the NEAR_MISS_RATIO
  // floor instead of two (0.8 then 0.6) — provably equivalent: windows are
  // processed ratio-descending, so the ≥ 0.8 subset is picked first and the
  // 0.6 floor only adds tail windows below 0.8 (which the post-filter drops
  // for the report and only uses as the near-miss hint).
  const picked = nearestCandidates(fileLines, oldLines, { minRatio: NEAR_MISS_RATIO, topK: 2 });
  const candidates = picked.filter((c) => c.ratio >= 0.8);
  if (candidates.length > 0) {
    return {
      class: 'candidates',
      lineRange: { startLine: candidates[0].startLine, endLine: candidates[0].endLine },
      report: formatCandidateReport(_path, candidates, oldText),
    };
  }

  // No qualifying window — near-miss hint when the best window is ≥ 0.6.
  const nearMiss = picked[0];
  if (nearMiss) {
    return {
      class: 'no-match',
      lineRange: { startLine: nearMiss.startLine, endLine: nearMiss.endLine },
      report: `Read the file in the matching region first (nearest region: lines ${nearMiss.startLine}–${nearMiss.endLine}).`,
    };
  }
  return { class: 'no-match' };
}
