import { Buffer } from 'node:buffer';
import { describe, it, expect } from 'vitest';
import {
  version,
  normalizeToLF,
  stripBom,
  normalizeForFuzzyMatch,
  fuzzyFindText,
  countOccurrences,
  builtinWouldMatch,
  normWs,
  splitLinesWithEndings,
  findNormalizedMatches,
  resolveRewrite,
  lineRatio,
  nearestCandidates,
  formatCandidateReport,
  listOccurrences,
  formatDuplicateReport,
  classifyEdit,
} from '../src/edit-fallback.js';

// ─── scaffold ──────────────────────────────────────────────────────────────

describe('scaffold', () => {
  it('exports a semver version string', () => {
    expect(version).toBeTypeOf('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ─── built-in predicate port (2.1) ─────────────────────────────────────────

describe('built-in predicate port', () => {
  it('normalizeToLF: CRLF and lone CR → LF', () => {
    expect(normalizeToLF('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(normalizeToLF('plain\n')).toBe('plain\n');
  });

  it('stripBom: with and without BOM', () => {
    expect(stripBom('\uFEFFabc')).toEqual({ bom: '\uFEFF', text: 'abc' });
    expect(stripBom('abc')).toEqual({ bom: '', text: 'abc' });
  });

  it('normalizeForFuzzyMatch: NFKC + trimEnd + smart quotes + dashes + spaces (byte-for-byte semantics)', () => {
    // Smart quotes → ASCII
    expect(normalizeForFuzzyMatch('\u2018a\u2019\u201Cb\u201D')).toBe(`'a'"b"`);
    // En/em dashes and minus → hyphen
    expect(normalizeForFuzzyMatch('a\u2013b\u2014c\u2212d')).toBe('a-b-c-d');
    // NBSP / ideographic space → regular space
    expect(normalizeForFuzzyMatch('a\u00A0b\u3000c')).toBe('a b c');
    // Trailing whitespace per line stripped
    expect(normalizeForFuzzyMatch('a  \nb\t\n')).toBe('a\nb\n');
    // NFKC: fullwidth → ASCII
    expect(normalizeForFuzzyMatch('\uFF21')).toBe('A'); // U+FF21 fullwidth capital A (U+FF41 is lowercase ａ)
  });

  it('fuzzyFindText: exact match found', () => {
    expect(fuzzyFindText('hello world\n', 'hello').found).toBe(true);
  });

  it('fuzzyFindText: typography-fuzzy match (smart quotes + dash glyphs in oldText, ASCII + em dash in file)', () => {
    const content = "const s = 'hi'; // note \u2014 end\n";
    const oldText = 'const s = \u2018hi\u2019; // note \u2013 end\n';
    expect(fuzzyFindText(content, oldText).found).toBe(true);
  });

  it('fuzzyFindText: both exact and fuzzy miss → not found', () => {
    expect(fuzzyFindText('alpha\nbeta\n', 'gamma').found).toBe(false);
  });

  it('countOccurrences: fuzzy-space count (smart quotes collapse to one)', () => {
    const content = "a 'x' b\nz\na 'x' b\n";
    expect(countOccurrences(content, 'a \u2018x\u2019 b\n')).toBe(2);
    expect(countOccurrences('nope\n', 'x')).toBe(0);
  });

  it('builtinWouldMatch: mirrors the built-in path (stripBom → normalizeToLF → fuzzyFindText)', () => {
    const content = '\uFEFFfirst\r\n  "second" line\r\n';
    expect(builtinWouldMatch(content, 'first\n  "second" line')).toBe(true); // exact (after normalization)
    expect(builtinWouldMatch(content, 'first\n  \u201Csecond\u201D line')).toBe(true); // typography-fuzzy
    expect(builtinWouldMatch(content, 'missing')).toBe(false);
  });
});

// ─── whitespace normalization + match search (2.2) ─────────────────────────

describe('normWs + findNormalizedMatches', () => {
  it('normWs: trim + collapse internal runs, blank lines preserved (line count kept)', () => {
    expect(normWs('  a   b \n\n\tc  \n')).toBe('a b\n\nc\n');
    expect(normWs('  a   b  ').split('\n')).toHaveLength(1);
  });

  it('splitLinesWithEndings keeps line endings', () => {
    expect(splitLinesWithEndings('a\nb\nc')).toEqual(['a\n', 'b\n', 'c']);
    expect(splitLinesWithEndings('')).toEqual([]);
  });

  it('findNormalizedMatches: contiguous 1:1 windows only (indent + tab drift)', () => {
    const file = ['x\n', '  a\n', '\tb\n', 'c\n', '  a\n', 'b\n'];
    const starts = findNormalizedMatches(file, ['a', 'b']);
    expect(starts).toEqual([1, 4]);
  });

  it('findNormalizedMatches: 1:1 line mapping required (3-line window does not match a 2-line oldText)', () => {
    const file = ['a\n', 'b\n', 'c\n'];
    expect(findNormalizedMatches(file, ['a', 'b', 'c', 'd'])).toEqual([]);
    expect(findNormalizedMatches(file, ['d'])).toEqual([]);
  });

  it('findNormalizedMatches: blank lines are empty strings (whitespace-only lines normalize to blank)', () => {
    const file = ['a\n', '   \n', 'b\n'];
    expect(findNormalizedMatches(file, ['a', '', 'b'])).toEqual([0]);
  });

  it('findNormalizedMatches: last line without a trailing newline still matches', () => {
    const file = ['a\n', 'b'];
    expect(findNormalizedMatches(file, ['a', 'b'])).toEqual([0]);
  });
});

// ─── stage 1: rewrite ───────────────────────────────────────────────────────

const LF_FILE = 'line1\nline2\nline3\nline4\nline5\n';

describe('resolveRewrite', () => {
  it('exact-match oldText → null (zero intervention on working edits)', () => {
    expect(resolveRewrite(LF_FILE, 'line2\n', 'LINE2\n')).toBeNull();
  });

  it('typography-fuzzy oldText → null (the built-in handles it)', () => {
    const content = "const s = 'hi'; // note \u2014 end\nnext\n";
    expect(
      resolveRewrite(content, 'const s = \u2018hi\u2019; // note \u2013 end\n', 'x'),
    ).toBeNull();
  });

  it('unique whitespace drift (indent) → file-exact bytes + lineRange (LF file)', () => {
    const content = 'function foo() {\n    const x = 1;\n    return x;\n}\n';
    const oldText = 'function foo() {\n  const x = 1;\n  return x;\n}';
    const r = resolveRewrite(content, oldText, 'function foo() {\n}');
    expect(r).not.toBeNull();
    // Region = the file's exact bytes for lines 1–4, INCLUDING line terminators
    expect(r!.rewrittenOldText).toBe('function foo() {\n    const x = 1;\n    return x;\n}\n');
    expect(r!.lineRange).toEqual({ startLine: 1, endLine: 4 });
  });

  it('unique whitespace drift on a CRLF file → CRLF bytes preserved', () => {
    const content = 'alpha\r\n  beta\r\ngamma\r\n';
    const oldText = 'alpha\nbeta\ngamma';
    const r = resolveRewrite(content, oldText, 'alpha\nBETA\ngamma');
    expect(r!.rewrittenOldText).toBe('alpha\r\n  beta\r\ngamma\r\n');
    expect(r!.lineRange).toEqual({ startLine: 1, endLine: 3 });
  });

  it('BOM file with the match on line 1 → BOM excluded, file bytes for the rest', () => {
    const content = '\uFEFFfirst\n  second\nthird\n';
    const r = resolveRewrite(content, 'first\nsecond', 'FIRST');
    expect(r!.rewrittenOldText).toBe('first\n  second\n');
    expect(r!.rewrittenOldText.startsWith('\uFEFF')).toBe(false);
    expect(r!.lineRange).toEqual({ startLine: 1, endLine: 2 });
  });

  it('tab-vs-space drift → rewrite', () => {
    const content = 'a\n\tfoo(1);\nb\n';
    const r = resolveRewrite(content, 'a\n    foo(1);\nb', 'x');
    expect(r!.rewrittenOldText).toBe('a\n\tfoo(1);\nb\n');
  });

  it('internal whitespace-run drift → rewrite', () => {
    const content = 'x  =  1\ny = 2\n';
    const r = resolveRewrite(content, 'x = 1\ny = 2', 'x = 9\ny = 2');
    expect(r!.rewrittenOldText).toBe('x  =  1\ny = 2\n');
  });

  it('ambiguous (two identical blocks) → null (never rewrite an ambiguous match)', () => {
    const content = '  a\n  b\nmid\n  a\n  b\n';
    expect(resolveRewrite(content, 'a\nb', 'c')).toBeNull();
  });

  it('oldText === newText → null (no-op attempt keeps the built-in error)', () => {
    const content = '  a\n  b\n';
    expect(resolveRewrite(content, 'a\nb', 'a\nb')).toBeNull();
  });

  it('no normalized match → null', () => {
    expect(resolveRewrite(LF_FILE, 'totally\nmissing\n', 'x')).toBeNull();
  });

  it('lone-CR (old-Mac) file → null (no sound 1:1 line mapping)', () => {
    const content = 'a\rb\n';
    expect(resolveRewrite(content, 'a b', 'x')).toBeNull();
  });
});

// ─── stage 2: nearest-match candidates ─────────────────────────────────────

describe('lineRatio (difflib port)', () => {
  it('identical arrays → 1.0; disjoint → 0.0; empty → 1.0', () => {
    expect(lineRatio(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(lineRatio(['a'], ['b'])).toBe(0);
    expect(lineRatio([], [])).toBe(1);
  });

  it('known values (verified against python difflib, autojunk off)', () => {
    expect(lineRatio(['a', 'b', 'c'], ['a', 'x', 'c'])).toBeCloseTo(2 / 3, 12);
    expect(lineRatio(['m', 'n'], ['n', 'm'])).toBeCloseTo(0.5, 12);
    expect(lineRatio(['p', 'q', 'r', 's', 't'], ['q', 'r', 's', 't', 'u'])).toBeCloseTo(0.8, 12);
  });
});

describe('nearestCandidates', () => {
  const file9 = ['L1\n', 'L2\n', 'L3\n', 'L4\n', 'NEW\n', 'L5\n', 'L6\n', 'L7\n', 'L8\n'];
  const old8 = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];

  it('off-by-one-line drift (file has an extra line) → delta +1 window found', () => {
    const cands = nearestCandidates(file9, old8);
    expect(cands).toHaveLength(1);
    expect(cands[0].startLine).toBe(1);
    expect(cands[0].endLine).toBe(9);
    expect(cands[0].ratio).toBeCloseTo(16 / 17, 12);
  });

  it('hallucinated extra oldText line → delta −1 window found', () => {
    const file8 = ['L1\n', 'L2\n', 'L3\n', 'L4\n', 'L5\n', 'L6\n', 'L7\n', 'L8\n'];
    const old9 = ['L1', 'L2', 'L3', 'L4', 'EXTRA', 'L5', 'L6', 'L7', 'L8'];
    const cands = nearestCandidates(file8, old9);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ startLine: 1, endLine: 8, ratio: 16 / 17 });
  });

  it('single-token drift (1 char in one of 10 lines) → candidate at 0.9', () => {
    const file: string[] = [];
    const old: string[] = [];
    for (let i = 0; i < 10; i++) {
      file.push(`line ${i} variable\n`);
      old.push(i === 5 ? `line ${i} variab1` : `line ${i} variable`);
    }
    const cands = nearestCandidates(file, old);
    expect(cands).toHaveLength(1);
    expect(cands[0].ratio).toBeCloseTo(0.9, 12);
    expect(cands[0]).toMatchObject({ startLine: 1, endLine: 10 });
  });

  it('minRatio threshold: configurable boundary (default 0.8 excludes 0.571; 0.55 includes it)', () => {
    // Best window: [p,q,r] vs [p,x,r,z] → 2M/T = 4/7 ≈ 0.571
    const file = ['p\n', 'q\n', 'r\n', 's\n'];
    const old = ['p', 'x', 'r', 'z'];
    expect(nearestCandidates(file, old)).toEqual([]);
    const loose = nearestCandidates(file, old, { minRatio: 0.55 });
    expect(loose).toHaveLength(1);
    expect(loose[0].ratio).toBeCloseTo(4 / 7, 12);
  });

  it('best ratio < 0.8 → excluded (no candidates)', () => {
    // Best window: [b,c,d] vs [q,b,r,d] → 2M/T = 4/7 ≈ 0.571 < 0.8
    const file = ['a\n', 'b\n', 'c\n', 'd\n'];
    const old = ['q', 'b', 'r', 'd'];
    expect(nearestCandidates(file, old)).toEqual([]);
  });

  it('second region within maxRatioGap of the best → excluded', () => {
    // X (55 lines) appears twice; the second copy drifts in 1 line → ratio
    // 0.9818, gap 0.0182 < 0.03 → only the first region reported.
    // (n must be ≥ 50: a +1-shifted window over a drifted n-line copy scores
    // 3/(2n+1) below 1.0, which only drops under the 0.03 gap for n ≥ 50.)
    const file: string[] = [];
    for (let i = 0; i < 55; i++) file.push(`X${i}\n`);
    file.push('F0\n');
    for (let i = 0; i < 55; i++) file.push(i === 20 ? `X${i}-drift\n` : `X${i}\n`);
    const old = Array.from({ length: 55 }, (_, i) => `X${i}`);
    const cands = nearestCandidates(file, old);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ startLine: 1, endLine: 55, ratio: 1 });
  });

  it('second region with a gap beyond maxRatioGap → both reported (topK=2)', () => {
    // Same shape with 30-line regions; second copy ratio 58/60 ≈ 0.9667;
    // gap 0.0333 >= 0.03 → both reported.
    const file: string[] = [];
    for (let i = 0; i < 30; i++) file.push(`X${i}\n`);
    file.push('F0\n', 'F1\n');
    for (let i = 0; i < 30; i++) file.push(i === 20 ? `X${i}-drift\n` : `X${i}\n`);
    const old = Array.from({ length: 30 }, (_, i) => `X${i}`);
    const cands = nearestCandidates(file, old);
    expect(cands).toHaveLength(2);
    expect(cands[0]).toMatchObject({ startLine: 1, endLine: 30, ratio: 1 });
    expect(cands[1]).toMatchObject({ startLine: 33, endLine: 62 });
    expect(cands[1].ratio).toBeCloseTo(58 / 60, 12);
  });

  it('empty oldLines → no candidates', () => {
    expect(nearestCandidates(['a\n'], [])).toEqual([]);
  });
});

// ─── stage 3: duplicate listing ────────────────────────────────────────────

describe('listOccurrences + formatDuplicateReport', () => {
  const file = ['ctx\n', 'x = 1\n', 'ctx\n', 'ctx\n', 'x = 1\n', 'ctx\n', 'x = 1\n', 'end\n'];

  it('three identical lines → 1-based line numbers + 20-char snippets', () => {
    const occ = listOccurrences(file, ['x = 1']);
    expect(occ).toEqual([
      { line: 2, snippet20: 'x = 1' },
      { line: 5, snippet20: 'x = 1' },
      { line: 7, snippet20: 'x = 1' },
    ]);
  });

  it('max caps the list', () => {
    expect(listOccurrences(file, ['x = 1'], 2)).toHaveLength(2);
  });

  it('smart-quote oldText → fuzzy cascade still resolves the lines', () => {
    const smartFile = ["a 'x' b\n", "a 'x' b\n", 'end\n'];
    const occ = listOccurrences(smartFile, ['a \u2018x\u2019 b']);
    expect(occ.map((o) => o.line)).toEqual([1, 2]);
  });

  it('20-char snippet truncation', () => {
    const occ = listOccurrences(
      ['a very long line of code here\n'],
      ['a very long line of code here'],
    );
    expect(occ[0].snippet20).toBe('a very long line of …');
  });

  it('formatDuplicateReport: line list + guidance', () => {
    const report = formatDuplicateReport('/f.ts', listOccurrences(file, ['x = 1']), 3);
    expect(report).toContain('occurs 3 times in /f.ts');
    expect(report).toContain('line 2: x = 1');
    expect(report).toContain('line 5: x = 1');
    expect(report).toContain('line 7: x = 1');
    expect(report).toContain('Add more context to make oldText unique.');
  });

  it('formatDuplicateReport: zero resolved occurrences → re-read guidance', () => {
    const report = formatDuplicateReport('/f.ts', [], 2);
    expect(report).toContain('line numbers could not be resolved');
    expect(report).toContain('Re-read the file');
  });
});

// ─── formatCandidateReport golden (2.6) ────────────────────────────────────

describe('formatCandidateReport', () => {
  it('golden shape: line range, ratio (3dp), unified diff, closing guidance', () => {
    // Off-by-one region: the file has an extra line inside the model's region.
    const file = ['alpha\n', 'beta\n', 'NEWLINE\n', 'gamma\n', 'delta\n'];
    const cands = nearestCandidates(file, ['alpha', 'beta', 'gamma']);
    expect(cands).toHaveLength(1);
    const report = formatCandidateReport('/tmp/f.txt', cands, 'alpha\nbeta\ngamma');
    expect(report).toContain('Nearest match (lines 1–4, ratio 0.857):');
    expect(report).toContain('+NEWLINE');
    expect(report).toContain(
      'Re-issue the edit with the exact file text (lines 1–4) or read the file at offset 1.',
    );
  });
});

// ─── orchestrator: classifyEdit (2.5) ──────────────────────────────────────

describe('classifyEdit', () => {
  it('working edit (exact) → none, zero fields', () => {
    expect(classifyEdit('/f', LF_FILE, 'line2\n', 'LINE2\n')).toEqual({ class: 'none' });
  });

  it('working edit (typography-fuzzy) → none', () => {
    const content = "const s = 'hi'; // note \u2014 end\nnext\n";
    expect(
      classifyEdit('/f', content, 'const s = \u2018hi\u2019; // note \u2013 end\n', 'x'),
    ).toEqual({
      class: 'none',
    });
  });

  it('unique whitespace drift → rewrite with file-exact bytes + lineRange', () => {
    const content = 'function foo() {\n    const x = 1;\n    return x;\n}\n';
    const r = classifyEdit(
      '/f',
      content,
      'function foo() {\n  const x = 1;\n  return x;\n}',
      'NEW',
    );
    expect(r.class).toBe('rewrite');
    expect(r.rewrittenOldText).toBe('function foo() {\n    const x = 1;\n    return x;\n}\n');
    expect(r.lineRange).toEqual({ startLine: 1, endLine: 4 });
    expect(r.report).toBeUndefined();
  });

  it('ambiguous (two identical blocks) → candidates report, NO rewrite', () => {
    const content = '  a\n  b\nmid\n  a\n  b\n';
    const r = classifyEdit('/f', content, 'a\nb', 'c');
    expect(r.class).toBe('candidates');
    expect(r.rewrittenOldText).toBeUndefined();
    expect(r.report).toContain('Nearest match (lines 1–2, ratio 1.000):');
  });

  it('off-by-one-line drift → candidates via delta window', () => {
    const content = ['L1', 'L2', 'L3', 'L4', 'NEW', 'L5', 'L6', 'L7', 'L8'].join('\n') + '\n';
    const oldText = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'].join('\n');
    const r = classifyEdit('/f', content, oldText, 'x');
    expect(r.class).toBe('candidates');
    expect(r.lineRange).toEqual({ startLine: 1, endLine: 9 });
    expect(r.report).toContain('lines 1–9');
  });

  it('single-token drift → candidates', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} variable`);
    const content = lines.join('\n') + '\n';
    const old = lines.slice();
    old[5] = 'line 5 variab1';
    const r = classifyEdit('/f', content, old.join('\n'), 'x');
    expect(r.class).toBe('candidates');
    expect(r.report).toContain('Nearest match (lines 1–10, ratio 0.900):');
  });

  it('3-line drift of 10 (ratio 0.7) → no-match + near-miss hint', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} same`);
    const content = lines.join('\n') + '\n';
    const old = lines.slice();
    old[2] = 'DIFFERENT 2';
    old[5] = 'DIFFERENT 5';
    old[8] = 'DIFFERENT 8';
    const r = classifyEdit('/f', content, old.join('\n'), 'x');
    expect(r.class).toBe('no-match');
    expect(r.report).toContain(
      'Read the file in the matching region first (nearest region: lines 1–10).',
    );
  });

  it('completely unrelated oldText → no-match, plain (no report)', () => {
    const r = classifyEdit('/f', LF_FILE, 'zzz\nqqq\nwww', 'x');
    expect(r.class).toBe('no-match');
    expect(r.report).toBeUndefined();
  });

  it('duplicates ×3 → duplicates + line numbers', () => {
    const content = 'ctx\nx = 1\nctx\nctx\nx = 1\nctx\nx = 1\nend\n';
    const r = classifyEdit('/f', content, 'x = 1\n', 'y = 2');
    expect(r.class).toBe('duplicates');
    expect(r.report).toContain('line 2: x = 1');
    expect(r.report).toContain('line 5: x = 1');
    expect(r.report).toContain('line 7: x = 1');
  });

  it('empty oldText → none (built-in error path unchanged)', () => {
    expect(classifyEdit('/f', LF_FILE, '', 'x')).toEqual({ class: 'none' });
  });

  it('oldText === newText (drifted, unique match) → none', () => {
    const content = '  a\n  b\n';
    expect(classifyEdit('/f', content, 'a\nb', 'a\nb')).toEqual({ class: 'none' });
  });

  it('whitespace-only oldText → built-in fuzzy space decides (zero intervention)', () => {
    // File with two consecutive blank lines: the built-in's fuzzy space
    // (whitespace-only lines → "\n" each) finds it uniquely → none.
    expect(classifyEdit('/f', 'a\n\n\nb\n', '  \n \n', 'x')).toEqual({ class: 'none' });
    // File with no blank lines: the built-in fails it not-found → plain
    // no-match (existing one-line hint stays).
    const r = classifyEdit('/f', LF_FILE, '   \n  \n', 'x');
    expect(r.class).toBe('no-match');
    expect(r.report).toBeUndefined();
  });

  it('> 1 MB content → too-large, no scan', () => {
    const big = Array.from({ length: 40000 }, (_, i) => `line ${i} padding padding padding`).join(
      '\n',
    );
    expect(Buffer.byteLength(big)).toBeGreaterThan(1024 * 1024);
    // oldText must NOT be found (drifted) — a found+unique oldText would be
    // `none` before the size guard, and a found+multiple one `duplicates`.
    const r = classifyEdit('/f', big, 'line 39999 padding padding paddings', 'x');
    expect(r.class).toBe('too-large');
    expect(r.report).toContain('File too large');
  });

  it('long file (5k lines) classifies in < 50 ms', () => {
    const long =
      Array.from({ length: 5000 }, (_, i) => `const value_${i} = ${i};`).join('\n') + '\n';
    const oldLines: string[] = [];
    for (let i = 2490; i < 2510; i++) {
      oldLines.push(i === 2500 ? `const value_${i} = ${i + 1};` : `const value_${i} = ${i};`);
    }
    const t0 = Date.now();
    const r = classifyEdit('/f', long, oldLines.join('\n'), 'x');
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(r.class).toBe('candidates');
    expect(r.lineRange).toEqual({ startLine: 2491, endLine: 2510 });
  });
});
