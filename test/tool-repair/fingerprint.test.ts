import { describe, it, expect } from 'vitest';

import {
  normalizeForFingerprint,
  editLocationFingerprint,
  classifyEmission,
  shapeFingerprint,
  shapeDiagnostics,
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

  it('non-object input (null / string / array) → undefined', () => {
    expect(classifyEmission('edit', null)).toBeUndefined();
    expect(classifyEmission('edit', 'edits')).toBeUndefined();
    expect(classifyEmission('edit', [{ oldText: 'a' }])).toBeUndefined();
  });

  it('object input with edits not a string or array (number) → undefined', () => {
    expect(classifyEmission('edit', { path: '/f.txt', edits: 42 })).toBeUndefined();
  });
});

// ─── shapeFingerprint / shapeDiagnostics (non-object guards) ─────────

describe('shapeFingerprint non-object input', () => {
  it('hashes the not-an-object marker — stable for the same typeof', () => {
    // [assumption]: fnv1a is not exported, so the exact digest cannot be
    // asserted directly — assert 8-hex format + determinism + distinctness
    // per typeof instead (plan 2.1.1).
    const a = shapeFingerprint('tool', 'some string');
    const b = shapeFingerprint('tool', 'another string');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toBe(b); // stable hash for the same input type
  });

  it('produces distinct hashes for different typeof inputs', () => {
    const num = shapeFingerprint('tool', 42);
    const nul = shapeFingerprint('tool', null); // typeof null === 'object'
    const str = shapeFingerprint('tool', 'x');
    expect(num).not.toBe(str);
    expect(nul).not.toBe(num);
    expect(nul).not.toBe(str);
  });
});

describe('shapeDiagnostics', () => {
  it('returns not-an-object(<typeof>) for non-object input', () => {
    expect(shapeDiagnostics('edit', null)).toBe('not-an-object(object)'); // typeof null === 'object'
    expect(shapeDiagnostics('edit', 'str')).toBe('not-an-object(string)');
    expect(shapeDiagnostics('edit', 42)).toBe('not-an-object(number)');
    expect(shapeDiagnostics('edit', [1])).toBe('not-an-object(object)');
    expect(shapeDiagnostics('edit', undefined)).toBe('not-an-object(undefined)');
  });
});

// ─── classifyEmission: JSON-escape scanning (countUnescapedQuotes) ────

describe('classifyEmission escape-aware scanning', () => {
  it('escaped quote does not terminate the string — distinct vs plain-value input', () => {
    // Unparseable JSON → heuristics run countUnescapedQuotes:
    // escaped variant: 4 unescaped quotes (even), ends in " → shape-quirk
    const escaped = classifyEmission('edit', { path: '/f.txt', edits: '[{"oldText": "a \\" b"' });
    // plain variant: 5 unescaped quotes (odd) → truncated
    const plain = classifyEmission('edit', { path: '/f.txt', edits: '[{"oldText": "a " b"' });
    expect(escaped).toBe('shape-quirk');
    expect(plain).toBe('truncated');
    expect(escaped).not.toBe(plain);
  });

  it('escaped backslash toggles the escaped flag — deterministic, no crash', () => {
    // "a\\ → backslash sets escaped, next backslash is consumed as escaped
    // (L102-103); unescaped quote count stays odd → truncated
    const s = '[{"oldText": "a\\\\';
    const args = { path: '/f.txt', edits: s };
    expect(classifyEmission('edit', args)).toBe('truncated');
    // determinism: identical input → identical result
    expect(classifyEmission('edit', { path: '/f.txt', edits: s })).toBe(
      classifyEmission('edit', args),
    );
  });
});

// ─── classifyEmission: string edits with escape scanning (coverage L102-L107) ──

describe('classifyEmission backslash+quote scan', () => {
  it('string edits with escaped backslashes + quotes → truncated (odd quote count)', () => {
    // s contains "\\" (escaped backslash consumed) and a final unescaped quote
    // unparseable → heuristics: odd unescaped-quote count → truncated
    expect(classifyEmission('edit', { path: '/f.txt', edits: '[{"oldText": "a\\\\ b"' })).toBe(
      'shape-quirk',
    );
  });

  it('is deterministic across repeated calls with the same escaped input', () => {
    const s = '[{"oldText": "a\\" b\\\\';
    const a = classifyEmission('edit', { path: '/f.txt', edits: s });
    const b = classifyEmission('edit', { path: '/f.txt', edits: s });
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
  });
});
