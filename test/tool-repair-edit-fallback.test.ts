/**
 * Step 3 wiring tests — fuzzy/nearest-match edit fallback (fake-pi harness,
 * plan 1.1). Covers plan 3.4: working edits untouched, drift rewrite +
 * applied telemetry, ambiguous → candidate report, duplicates → line
 * numbers, multi-edit scoping + no partial state, guards (no-op, unreadable
 * file), disabled-flag byte-identity, pending-map cap, telemetry shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// getAgentDir is only used when logPath is absent; tests always pass logPath.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/must/not/be/used',
}));

import { toolRepairExtension } from '../src/tool-repair.js';

// ─── harness (same pattern as tool-repair.test.ts) ──────────────────────

function makeMockPi() {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  const on = vi.fn((event: string, handler: any) => {
    handlers[event] = handler;
  });
  const api = {
    on,
    getActiveTools: () => ['bash', 'read', 'edit', 'write'],
  } as any;
  return { api, handlers };
}

function readLog(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Built-in pi error signatures (dist/core/tools/edit-diff.js). */
const errNotFound = (path: string): string =>
  `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
const errNotFoundMulti = (path: string, i: number): string =>
  `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`;
const errNotUnique = (path: string, n: number): string =>
  `Found ${n} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`;

let dir: string;
let logPath: string;
const mkfile = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
};

const editEndEvent = (path: string, edits: any[], id = 'call-1') => ({
  type: 'message_end',
  message: {
    role: 'assistant' as const,
    content: [
      { type: 'text' as const, text: 'working…' },
      { type: 'toolCall' as const, id, name: 'edit' as const, arguments: { path, edits } },
    ],
  },
});

const resultEvent = (id: string, text: string, input: any, isError: boolean) => ({
  type: 'tool_result',
  toolCallId: id,
  toolName: 'edit',
  input,
  content: [{ type: 'text', text }],
  isError,
});

/** ctx with a cwd — the fallback resolves relative paths against it. */
const ctxFor = (cwd: string) => ({ model: { id: 'test-model' }, cwd });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'henyo-edit-fb-'));
  logPath = join(dir, 'tool-repair.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── 3.4: untouched working edits ───────────────────────────────────────

describe('working edits — untouched, no logs', () => {
  it('exact-match oldText → args untouched, no log records', async () => {
    const f = mkfile('a.txt', 'line1\n  line2\nline3\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'line1\n  line2\nline3', newText: 'CHANGED' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeUndefined(); // no message rewrite
    expect(edits[0].oldText).toBe('line1\n  line2\nline3');
    expect(readLog(logPath)).toHaveLength(0);
  });

  it('typography-fuzzy oldText (smart quote) → untouched (built-in would handle it)', async () => {
    const f = mkfile('g.txt', "it's here\n");
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'it\u2019s here', newText: 'it was here' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeUndefined();
    expect(edits[0].oldText).toBe('it\u2019s here');
    expect(readLog(logPath)).toHaveLength(0);
  });
});

// ─── 3.4: drift rewrite → applied ───────────────────────────────────────

describe('whitespace-drift single edit — rewrite + applied telemetry', () => {
  it('rewrites oldText to file-exact bytes; success result → applied record', async () => {
    // relative path — resolved against ctx.cwd
    mkfile('a.txt', 'line1\n  line2\nline3\n');
    const f = 'a.txt';
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'line1\nline2\nline3', newText: 'line1\nline2\nline3!' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeDefined();
    const args = (out as any).message.content[1].arguments;
    // file-exact bytes incl. the region's final-line terminator
    expect(args.edits[0].oldText).toBe('line1\n  line2\nline3\n');
    expect(args.edits[0].newText).toBe('line1\nline2\nline3!');

    const fixed = readLog(logPath).filter((r) => r.outcome === 'fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0].rules).toEqual(['whitespace-normalize-oldtext']);
    expect(fixed[0].toolCallId).toBe('call-1');
    expect(fixed[0].editIndex).toBe(0);
    expect(fixed[0].lineRange).toEqual({ startLine: 1, endLine: 3 });
    expect(fixed[0].fileLines).toBe(3);
    expect(fixed[0].oldTextLines).toBe(3);
    expect(fixed[0].sha12).toBe(
      createHash('sha256').update('line1\nline2\nline3', 'utf8').digest('hex').slice(0, 12),
    );

    // simulated success → applied record, pending consumed
    const res = await handlers['tool_result'](
      resultEvent('call-1', 'Successfully edited a.txt', args, false),
      ctxFor(dir),
    );
    expect(res).toBeUndefined(); // successful result content untouched
    const applied = readLog(logPath).filter((r) => r.outcome === 'applied');
    expect(applied).toHaveLength(1);
    expect(applied[0].toolCallId).toBe('call-1');
    expect(applied[0].editIndex).toBe(0);
    expect(applied[0].lineRange).toEqual({ startLine: 1, endLine: 3 });
    expect(applied[0].fileLines).toBe(3);
    expect(applied[0].sha12).toBe(fixed[0].sha12);
  });
});

// ─── telemetry v2: ok denominator + applied (plan step 2.2) ──────────────

describe('successful edit with pending rewrites → ok + applied both (telemetry v2)', () => {
  it('2 drift rewrites → exactly 1 ok record and 2 applied records', async () => {
    mkfile('c.txt', 'aa  x\nbb y\ncc  z\ndd w\n');
    const f = 'c.txt';
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [
      { oldText: 'aa x\nbb y', newText: 'AA X\nBB Y' },
      { oldText: 'cc z\ndd w', newText: 'CC Z\nDD W' },
    ];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeDefined();
    const args = (out as any).message.content[1].arguments;
    const fixed = readLog(logPath).filter((r) => r.outcome === 'fixed');
    expect(fixed).toHaveLength(2); // 2 pending rewrites

    const res = await handlers['tool_result'](
      resultEvent('call-1', 'Successfully edited c.txt', args, false),
      ctxFor(dir),
    );
    expect(res).toBeUndefined();
    const ok = readLog(logPath).filter((r) => r.outcome === 'ok');
    const applied = readLog(logPath).filter((r) => r.outcome === 'applied');
    expect(ok).toHaveLength(1);
    expect(applied).toHaveLength(2);
    expect(ok[0].fingerprint).toBe(applied[0].fingerprint);
  });
});

// ─── 3.4: ambiguous → NOT rewritten, candidate report ───────────────────

describe('ambiguous edit — no rewrite, candidate report on not-found', () => {
  it('two identical blocks → args NOT rewritten; error result carries the report (0 auto-applies)', async () => {
    const f = mkfile('b.txt', 'alpha\nbeta\ngamma\ndelta\nalpha\nbeta\ngamma\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'alpha\n  beta\ngamma', newText: 'ALPHA' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    // no auto-apply: the rewrite flag is false — args byte-identical
    expect(out).toBeUndefined();
    expect(edits[0].oldText).toBe('alpha\n  beta\ngamma');
    expect(readLog(logPath)).toHaveLength(0);

    // built-in fails (leading-space drift beats its typography pass) → coaching
    const res = await handlers['tool_result'](
      resultEvent('call-1', errNotFound(f), { path: f, edits }, true),
      ctxFor(dir),
    );
    const text = res.content[0].text as string;
    // built-in error verbatim on top
    expect(text.startsWith(errNotFound(f))).toBe(true);
    // full report REPLACES the one-line hint
    expect(text).not.toContain('Re-read the file now');
    expect(text).toContain('Henyo note:');
    expect(text).toContain('Nearest match (lines 1–3, ratio 1.000):');
    expect(text).toContain('Nearest match (lines 5–7, ratio 1.000):');
    expect(text).toContain('Re-issue the edit with the exact file text (lines 1–3)');
    const failed = readLog(logPath).filter((r) => r.outcome === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].issues).toBe('content-not-found:candidates');
  });
});

// ─── 3.4: duplicates → occurrence line numbers ──────────────────────────

describe('duplicate edit — line numbers in the result', () => {
  it('not-unique error → one-line hint + occurrence list', async () => {
    const f = mkfile('c.txt', 'one\ntwo\nthree\nfour\none\ntwo\nthree\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const res = await handlers['tool_result'](
      resultEvent(
        'call-1',
        errNotUnique(f, 2),
        { path: f, edits: [{ oldText: 'one\ntwo\nthree', newText: 'x' }] },
        true,
      ),
      ctxFor(dir),
    );
    const text = res.content[0].text as string;
    expect(text.startsWith(errNotUnique(f, 2))).toBe(true);
    // existing one-line hint KEPT (append mode) + the duplicate report
    expect(text).toContain('Extend oldText with enough surrounding lines to be unique.');
    expect(text).toContain(`The text occurs 2 times in ${f}`);
    expect(text).toContain('line 1: one');
    expect(text).toContain('line 5: one');
    const failed = readLog(logPath).filter((r) => r.outcome === 'failed');
    expect(failed[0].issues).toBe('content-not-unique:listed');
  });
});

// ─── 3.4: multi-edit scoping ─────────────────────────────────────────────

describe('multi-edit calls', () => {
  it('1 drift + 1 exact → only the drift entry is rewritten', async () => {
    const f = mkfile('d.txt', 'aaa\n  bbb\nccc\nddd\neee\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [
      { oldText: 'ddd', newText: 'DDD' }, // exact — untouched
      { oldText: 'aaa\nbbb\nccc', newText: 'X' }, // indent drift — rewritten
    ];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    const args = (out as any).message.content[1].arguments;
    expect(args.edits[0].oldText).toBe('ddd');
    expect(args.edits[1].oldText).toBe('aaa\n  bbb\nccc\n');
    const fixed = readLog(logPath).filter((r) => r.outcome === 'fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0].editIndex).toBe(1);
    expect(fixed[0].lineRange).toEqual({ startLine: 1, endLine: 3 });
  });

  it('1 drift + 1 ambiguous → drift rewritten, error scoped to edits[1], no partial state', async () => {
    // NB: the built-in exact match is substring-based (indexOf) — the drift
    // must sit at a line boundary so `keep\nB` / `X2\nY2` are NOT substrings
    // of the indented file regions (a first-line-only indent drift would be
    // found as a mid-line substring and the built-in would handle it).
    const f = mkfile('e.txt', '  keep\n  B\nB\nX2\n  Y2\nX2\n  Y2\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [
      { oldText: 'keep\nB', newText: 'KEPT' }, // line-boundary drift — rewritten
      { oldText: 'X2\nY2', newText: 'X2!' }, // two identical drifted blocks — untouched
    ];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    const args = (out as any).message.content[1].arguments;
    expect(args.edits[0].oldText).toBe('  keep\n  B\n');
    expect(args.edits[1].oldText).toBe('X2\nY2');

    // the call fails on edits[1] (built-in apply is atomic — nothing applied)
    const res = await handlers['tool_result'](
      resultEvent('call-1', errNotFoundMulti(f, 1), args, true),
      ctxFor(dir),
    );
    const text = res.content[0].text as string;
    expect(text.startsWith(errNotFoundMulti(f, 1))).toBe(true);
    // report scoped to edits[1]'s regions (the two X2/Y2 blocks), not edits[0]
    expect(text).toContain('Nearest match (lines 4–5, ratio 1.000):');
    expect(text).toContain('Nearest match (lines 6–7, ratio 1.000):');
    // no partial state: the pending rewrite was consumed without `applied`
    const log = readLog(logPath);
    expect(log.filter((r) => r.outcome === 'applied')).toHaveLength(0);
    expect(log.filter((r) => r.outcome === 'fixed')).toHaveLength(1);
    expect(log.filter((r) => r.outcome === 'failed')[0].issues).toBe(
      'content-not-found:candidates',
    );
  });
});

// ─── 3.4: guards ─────────────────────────────────────────────────────────

describe('guards', () => {
  it('oldText === newText with drift → untouched (built-in error kept)', async () => {
    const f = mkfile('f.txt', 'p\n  q\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'p\nq', newText: 'p\nq' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeUndefined();
    expect(edits[0].oldText).toBe('p\nq');
    expect(readLog(logPath)).toHaveLength(0);
  });

  it('unreadable file → no rewrite, no log, no throw', async () => {
    const f = join(dir, 'missing.txt'); // never created
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'anything', newText: 'x' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeUndefined();
    expect(edits[0].oldText).toBe('anything');
    expect(readLog(logPath)).toHaveLength(0);
  });
});

// ─── 3.3/3.4: disabled → byte-identical to the no-feature build ─────────

describe('editFallback disabled — zero new behavior', () => {
  it.each([false, undefined])(
    'editFallbackEnabled = %s → drift args untouched, one-line coaching only, no new logs',
    async (gate) => {
      const f = mkfile('a.txt', 'line1\n  line2\nline3\n');
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, {
        enabled: true,
        logPath,
        ...(gate === undefined ? {} : { editFallbackEnabled: gate }),
      });
      const edits = [{ oldText: 'line1\nline2\nline3', newText: 'x' }];
      const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
      expect(out).toBeUndefined(); // no rewrite (feature-off build behaves identically)
      expect(edits[0].oldText).toBe('line1\nline2\nline3');
      expect(readLog(logPath)).toHaveLength(0);

      const res = await handlers['tool_result'](
        resultEvent('call-1', errNotFound(f), { path: f, edits }, true),
        ctxFor(dir),
      );
      // byte-identical to the no-feature build: built-in error + one-line hint only
      expect(res.content[0].text).toBe(
        `${errNotFound(f)}\n\nHenyo note: Re-read the file now (it may have changed since your last read) and copy oldText verbatim from the fresh read, including exact whitespace and newlines.`,
      );
      const failed = readLog(logPath).filter((r) => r.outcome === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].issues).toBe('content-not-found'); // plain category, no subcategory
    },
  );
});

// ─── 3.4: pending-map cap (FIFO) ────────────────────────────────────────

describe('pending-rewrite map cap', () => {
  it('101 pending rewrites → FIFO eviction, no unbounded growth (oldest call has no applied)', async () => {
    const lines = Array.from({ length: 101 }, (_, i) => `A${String(i + 1).padStart(3, '0')}`);
    const f = mkfile('cap.txt', lines.join('\n') + '\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    for (let i = 0; i < 101; i++) {
      const id = `call-${String(i).padStart(3, '0')}`;
      const edits = [{ oldText: ` A${String(i + 1).padStart(3, '0')}`, newText: 'Z' }];
      await handlers['message_end'](editEndEvent(f, edits, id), ctxFor(dir));
    }
    const fixed = readLog(logPath).filter((r) => r.outcome === 'fixed');
    expect(fixed).toHaveLength(101); // all 101 rewrites fired pre-execution
    for (let i = 0; i < 101; i++) {
      const id = `call-${String(i).padStart(3, '0')}`;
      await handlers['tool_result'](
        resultEvent(id, 'ok', { path: f, edits: [{ oldText: 'A', newText: 'Z' }] }, false),
        ctxFor(dir),
      );
    }
    const applied = readLog(logPath).filter((r) => r.outcome === 'applied');
    expect(applied).toHaveLength(100); // cap 100 — the oldest toolCallId was evicted
    expect(applied.map((r) => r.toolCallId)).not.toContain('call-000');
    expect(applied.map((r) => r.toolCallId)).toContain('call-100');
  });
});

// ─── 3.2: no-match near-miss + too-large ──────────────────────────────

describe('no-match and too-large failures', () => {
  it('single-token-ish drift (best 5/7 ≈ 0.714) → one-line hint + near-miss hint', async () => {
    const f = mkfile('h.txt', 'aa1\nbb2\ncc3\ndd4\nee5\nff6\ngg7\nhh8\nii9\njj10\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    // two tokens differ in a 7-line block → lineRatio 5/7 ≈ 0.714 (0.6 ≤ r < 0.8)
    const edits = [{ oldText: 'aa1\nbbX\ncc3\ndd4\nee5\nffY\ngg7', newText: 'X' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeUndefined(); // no rewrite (not a 1:1 normalized match)
    const res = await handlers['tool_result'](
      resultEvent('call-1', errNotFound(f), { path: f, edits }, true),
      ctxFor(dir),
    );
    const text = res.content[0].text as string;
    // existing one-line hint KEPT + near-miss hint appended
    expect(text).toContain('Re-read the file now');
    expect(text).toContain(
      'Read the file in the matching region first (nearest region: lines 1–7).',
    );
    expect(readLog(logPath).filter((r) => r.outcome === 'failed')[0].issues).toBe(
      'content-not-found:no-match',
    );
  });

  it('file > 1 MB → too-large report, no rewrite', async () => {
    const big = 'padline-fill\n'.repeat(90000); // ~1.17 MB
    const f = mkfile('big.txt', big);
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'padline-DIFFER\n', newText: 'X' }];
    const out = await handlers['message_end'](editEndEvent(f, edits), ctxFor(dir));
    expect(out).toBeUndefined(); // no rewrite (size guard)
    expect(readLog(logPath)).toHaveLength(0);
    const res = await handlers['tool_result'](
      resultEvent('call-1', errNotFound(f), { path: f, edits }, true),
      ctxFor(dir),
    );
    const text = res.content[0].text as string;
    expect(text).toContain('Henyo note: File too large for nearest-match analysis.');
    expect(text).not.toContain('Re-read the file now'); // replaced, not appended
    expect(readLog(logPath).filter((r) => r.outcome === 'failed')[0].issues).toBe('too-large');
  });
});

// ─── 3.4: telemetry JSONL shape (sha12 only, no argument values) ────────

describe('telemetry shape', () => {
  it('every new record parses; argument values never logged (sha12 only)', async () => {
    mkfile('a.txt', 'line1\n  line2\nline3\n');
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath, editFallbackEnabled: true });
    const edits = [{ oldText: 'line1\nline2\nline3', newText: 'x' }];
    await handlers['message_end'](editEndEvent('a.txt', edits), ctxFor(dir));
    await handlers['tool_result'](
      resultEvent('call-1', 'ok', { path: 'a.txt', edits }, false),
      ctxFor(dir),
    );
    const log = readLog(logPath); // throws if any line is not valid JSON
    expect(log).toHaveLength(3);
    for (const record of log) {
      const raw = JSON.stringify(record);
      expect(raw).not.toContain('line1\nline2\nline3'); // original oldText never logged
      expect(raw).not.toContain('line1\n  line2'); // rewritten bytes never logged
      expect(record.tool).toBe('edit');
      expect(record.model).toBe('test-model');
      expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      if (record.outcome === 'ok') continue; // v2 denominator — no rewrite fields
      expect(record.sha12).toMatch(/^[0-9a-f]{12}$/);
      expect(record.lineRange).toEqual({ startLine: 1, endLine: 3 });
      expect(record.fileLines).toBe(3);
      expect(record.oldTextLines).toBe(3);
    }
    expect(log.map((r) => r.outcome)).toEqual(['fixed', 'ok', 'applied']);
  });
});
