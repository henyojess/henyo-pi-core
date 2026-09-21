import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PENDING_REWRITE_CAP,
  rememberRewrite,
  applyEditFallback,
  classifyContentError,
} from '../../src/tool-repair/telemetry.js';

// ─── rememberRewrite (eviction loop) ─────────────────────────────────

/**
 * Stub of the `Map` surface rememberRewrite uses. `keys().next()` reports
 * `done: true` to force the loop's break without deleting anything;
 * `values()` reports `total` entries so `total() > CAP` holds on entry.
 */
function makeDoneStub(total: number) {
  const store = new Map<string, unknown[]>();
  return {
    store,
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown[]) => store.set(k, v),
    delete: (k: string) => store.delete(k),
    keys: () => ({ next: () => ({ done: true, value: undefined }) }),
    values: () => Array.from({ length: total }, () => [{}]),
  };
}

describe('rememberRewrite', () => {
  it('exits the eviction loop via break when the map is exhausted, keeping all entries', () => {
    const stub = makeDoneStub(PENDING_REWRITE_CAP + 1);
    rememberRewrite(stub as unknown as Map<string, never[]>, 'call-1', {
      path: '/x',
      editIndex: 0,
      lineRange: { startLine: 1, endLine: 2 },
      fileLines: 10,
      oldTextLines: 2,
      sha12: 'ab',
    });
    expect(stub.store.has('call-1')).toBe(true);
    // break path: the stub's `values()` still reports the seeded total — nothing evicted
    expect((stub.values() as unknown[]).length).toBe(PENDING_REWRITE_CAP + 1);
  });
});

// ─── applyEditFallback (shape guards) ────────────────────────────────

describe('applyEditFallback', () => {
  it('returns 0 and logs nothing when args.path is not a string', async () => {
    const pending = new Map<string, never[]>();
    const logs: unknown[] = [];
    const count = await applyEditFallback(
      { path: 42, edits: [{ oldText: 'a', newText: 'b' }] },
      'call-1',
      process.cwd(),
      undefined,
      pending,
      (record) => logs.push(record),
    );
    expect(count).toBe(0);
    expect(logs).toHaveLength(0);
    expect(pending.size).toBe(0);
  });

  it('returns 0 and logs nothing when args.edits is not an array', async () => {
    const pending = new Map<string, never[]>();
    const logs: unknown[] = [];
    const count = await applyEditFallback(
      { path: '/tmp/anyfile.txt', edits: 'not-an-array' },
      'call-2',
      process.cwd(),
      undefined,
      pending,
      (record) => logs.push(record),
    );
    expect(count).toBe(0);
    expect(logs).toHaveLength(0);
    expect(pending.size).toBe(0);
  });

  it('returns 0 and logs nothing when args.edits is an empty array', async () => {
    const pending = new Map<string, never[]>();
    const logs: unknown[] = [];
    const count = await applyEditFallback(
      { path: '/tmp/anyfile.txt', edits: [] },
      'call-3',
      process.cwd(),
      undefined,
      pending,
      (record) => logs.push(record),
    );
    expect(count).toBe(0);
    expect(logs).toHaveLength(0);
    expect(pending.size).toBe(0);
  });
});

// ─── applyEditFallback (entry-skip loop) ─────────────────────────────

describe('applyEditFallback entry-skip loop', () => {
  let tmpDir: string;
  let filePath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'henyo-telemetry-'));
    filePath = join(tmpDir, 'fixture.txt');
    // Indented content: 'hello\nworld' without the leading spaces does NOT
    // match the built-in exactly, but does match after whitespace
    // normalization → classifyEdit => 'rewrite'.
    writeFileSync(filePath, '  hello\n  world\n', 'utf8');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips malformed edit entries (null, number, array, wrong-typed fields) and rewrites only the valid entry', async () => {
    const pending = new Map<string, never[]>();
    const logs: unknown[] = [];
    const edits: unknown[] = [
      null, // L137 skip: null
      42, // L137 skip: number
      ['a'], // L137 skip: array
      { oldText: 1, newText: 'x' }, // L141 skip: oldText not a string
      { oldText: 'hello\nworld', newText: 'HELLO\nWORLD' }, // valid → rewrite
    ];
    const count = await applyEditFallback(
      { path: filePath, edits },
      'call-4',
      process.cwd(),
      'test-model',
      pending,
      (record) => logs.push(record),
    );
    expect(count).toBe(1);
    expect(logs).toHaveLength(1);
    expect(pending.size).toBe(1);
    expect(pending.get('call-4')?.length).toBe(1);
    const log = logs[0] as Record<string, unknown>;
    expect(log.outcome).toBe('fixed');
    expect(log.editIndex).toBe(4);
    // The valid entry was rewritten in place
    expect((edits[4] as Record<string, string>).oldText).toBe('  hello\n  world\n');
    // Malformed entries are untouched
    expect(edits[0]).toBeNull();
    expect(edits[1]).toBe(42);
    expect(Array.isArray(edits[2])).toBe(true);
  });
});

// ─── classifyContentError (null paths) ───────────────────────────────

describe('classifyContentError', () => {
  let tmpDir: string;
  let filePath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'henyo-telemetry-cc-'));
    filePath = join(tmpDir, 'target.txt');
    writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf8');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when path is not a string', async () => {
    const r = await classifyContentError(
      'content-not-found',
      'Could not find edits[0]',
      { path: 42, edits: [{ oldText: 'a', newText: 'b' }] },
      process.cwd(),
    );
    expect(r).toBeNull();
  });

  it('returns null when edits is not an array', async () => {
    const r = await classifyContentError(
      'content-not-found',
      'Could not find edits[0]',
      { path: filePath, edits: 'oops' },
      process.cwd(),
    );
    expect(r).toBeNull();
  });

  it('returns null when the referenced edits[i] entry is null', async () => {
    const r = await classifyContentError(
      'content-not-found',
      'Could not find edits[1] in the file',
      { path: filePath, edits: [{ oldText: 'a', newText: 'b' }, null] },
      process.cwd(),
    );
    expect(r).toBeNull();
  });

  it('returns null when oldText/newText are not both strings', async () => {
    const r = await classifyContentError(
      'content-not-found',
      'Could not find edits[0]',
      { path: filePath, edits: [{ oldText: 1, newText: 'b' }] },
      process.cwd(),
    );
    expect(r).toBeNull();
  });

  it('returns null when the file does not exist (readFile throws)', async () => {
    const r = await classifyContentError(
      'content-not-found',
      'Could not find edits[0]',
      { path: join(tmpDir, 'does-not-exist.txt'), edits: [{ oldText: 'a', newText: 'b' }] },
      process.cwd(),
    );
    expect(r).toBeNull();
  });

  it('returns null when the edit classifies as none (empty oldText → default case)', async () => {
    const r = await classifyContentError(
      'content-not-found',
      'Could not find edits[0]',
      { path: filePath, edits: [{ oldText: '', newText: 'b' }] },
      process.cwd(),
    );
    expect(r).toBeNull();
  });
});
