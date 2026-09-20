import { describe, it, expect } from 'vitest';

import {
  normalizeForFingerprint,
  editLocationFingerprint,
  classifyEmission,
} from '../../src/tool-repair/fingerprint.js';

// ─── editLocationFingerprint (telemetry v2, plan step 1.1) ────────────

describe('normalizeForFingerprint', () => {
  it('maps CRLF to LF, trims the whole, collapses whitespace runs per line', () => {
    expect(normalizeForFingerprint('  a   b\r\n  c  d\n')).toBe('a b\n c d');
  });
});

describe('editLocationFingerprint', () => {
  const locInput = (path: unknown, edits: unknown) => ({ path, edits });

  it('returns the same 8-hex fp for the same oldText + path (stable across calls)', () => {
    const a = editLocationFingerprint(locInput('/dir/a.txt', [{ oldText: 'hello', newText: 'x' }]));
    const b = editLocationFingerprint(locInput('/dir/a.txt', [{ oldText: 'hello', newText: 'y' }]));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toBe(b);
  });

  it('returns different fps for different oldText on the same path', () => {
    const a = editLocationFingerprint(locInput('/dir/a.txt', [{ oldText: 'hello', newText: 'x' }]));
    const b = editLocationFingerprint(locInput('/dir/a.txt', [{ oldText: 'world', newText: 'x' }]));
    expect(a).not.toBe(b);
  });

  it('returns the same fp for CRLF + extra-space variants of the same oldText', () => {
    const plain = editLocationFingerprint(
      locInput('/dir/a.txt', [{ oldText: 'line one\nline   two', newText: 'x' }]),
    );
    const variant = editLocationFingerprint(
      locInput('/dir/a.txt', [{ oldText: 'line one\r\nline two', newText: 'x' }]),
    );
    expect(plain).toBe(variant);
  });

  it('truncates oldText >120 chars but stays stable across calls', () => {
    const long = 'x'.repeat(200);
    const a = editLocationFingerprint(locInput('/dir/a.txt', [{ oldText: long, newText: 'x' }]));
    const b = editLocationFingerprint(locInput('/dir/a.txt', [{ oldText: long, newText: 'x' }]));
    expect(a).toBe(b);
  });

  it('returns undefined when path is missing or not a string', () => {
    expect(editLocationFingerprint({ edits: [{ oldText: 'a', newText: 'b' }] })).toBeUndefined();
    expect(editLocationFingerprint(locInput(42, [{ oldText: 'a', newText: 'b' }]))).toBeUndefined();
  });

  it('merges array edits entries in order (order matters)', () => {
    const fwd = editLocationFingerprint(
      locInput('/dir/a.txt', [{ oldText: 'a' }, { oldText: 'b' }]),
    );
    const rev = editLocationFingerprint(
      locInput('/dir/a.txt', [{ oldText: 'b' }, { oldText: 'a' }]),
    );
    const joined = editLocationFingerprint(locInput('/dir/a.txt', 'a\nb'));
    expect(fwd).toBe(joined);
    expect(fwd).not.toBe(rev);
  });

  it('returns undefined for non-object input', () => {
    expect(editLocationFingerprint(null)).toBeUndefined();
    expect(editLocationFingerprint('edits')).toBeUndefined();
    expect(editLocationFingerprint(42)).toBeUndefined();
    expect(editLocationFingerprint([{ oldText: 'a' }])).toBeUndefined();
  });

  it('returns undefined for an empty array edits (no resolvable oldText)', () => {
    expect(editLocationFingerprint(locInput('/dir/a.txt', []))).toBeUndefined();
  });

  it('uses the raw string edits as the oldText source', () => {
    const a = editLocationFingerprint(locInput('/dir/a.txt', '[{"oldText":"a","newText":"b"}]'));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ─── classifyEmission (telemetry v2, plan step 4.1) ─────────────────────

describe('classifyEmission', () => {
  const editIn = (edits: unknown) => ({ path: '/f.txt', edits });

  // truncated ×3
  it('string edits cut mid-string (unparseable, ends mid-quote) → truncated', () => {
    expect(classifyEmission('edit', editIn('[{"oldText": "abc'))).toBe('truncated');
  });

  it('odd unescaped quote count (dangling quote after a closed value) → truncated', () => {
    expect(classifyEmission('edit', editIn('{"oldText": "a" "'))).toBe('truncated');
  });

  it('array form with last entry missing newText → truncated', () => {
    expect(
      classifyEmission('edit', editIn([{ oldText: 'a', newText: 'b' }, { oldText: 'c' }])),
    ).toBe('truncated');
  });

  // glued ×2
  it('two glued objects (}{ ) → glued', () => {
    expect(
      classifyEmission(
        'edit',
        editIn('{"oldText": "a", "newText": "b"}{"oldText": "c", "newText": "d"}'),
      ),
    ).toBe('glued');
  });

  it('two "oldText" + }{ with whitespace between → glued', () => {
    expect(
      classifyEmission(
        'edit',
        editIn('{"oldText": "a", "newText": "b"} {"oldText": "c", "newText": "d"}'),
      ),
    ).toBe('glued');
  });

  // shape-quirk ×3
  it('parseable stringified array → shape-quirk', () => {
    expect(classifyEmission('edit', editIn('[{"oldText": "a", "newText": "b"}]'))).toBe(
      'shape-quirk',
    );
  });

  it('closed unparseable string with <function= debris and balanced quotes → shape-quirk', () => {
    expect(
      classifyEmission(
        'edit',
        editIn('{"oldText": "a", "newText": "b"} <fu' + 'nction=next>{"cmd":"ls"}'),
      ),
    ).toBe('shape-quirk');
  });

  it('array containing a string entry → shape-quirk', () => {
    expect(classifyEmission('edit', editIn(['{"oldText": "a"}']))).toBe('shape-quirk');
  });

  // undefined ×2
  it('non-edit tool → undefined', () => {
    expect(classifyEmission('bash', { command: 'ls' })).toBeUndefined();
  });

  it('edit with no edits field → undefined', () => {
    expect(classifyEmission('edit', { path: '/f.txt' })).toBeUndefined();
  });
});
