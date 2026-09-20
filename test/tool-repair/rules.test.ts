import { describe, it, expect } from 'vitest';
import {
  dropIncompleteEdits,
  hoistEditPath,
  recoverGarbledPath,
  repairStringifiedEdits,
  salvageCorruptEdits,
} from '../../src/tool-repair/rules.js';
import payloads from '../fixtures/edit-failure-payloads.json' with { type: 'json' };

// ─── step-4 fixture helpers ─────────────────────────────────────────────

type FixtureEntry = { model: string; args: Record<string, any> };
const fixtureGroup = (name: string): FixtureEntry[] =>
  (payloads as Record<string, FixtureEntry[]>)[name];

// Degeneration marker built via concatenation so the raw sequence never
// appears as a literal in this source (it triggers parser behavior downstream).
const THIN_OPEN = '<' + 'think' + '>';

// ─── hoistEditPath (6 cases ported from extractPath.test.ts) ───────────

describe('hoistEditPath', () => {
  it('returns false when no edits array', () => {
    const input: Record<string, unknown> = { path: '/f.txt' };
    expect(hoistEditPath(input)).toBe(false);
  });

  it('returns false when path already at top level', () => {
    const input: Record<string, unknown> = {
      path: '/f.txt',
      edits: [{ oldText: 'a', newText: 'b' }],
    };
    expect(hoistEditPath(input)).toBe(false);
    expect(input.path).toBe('/f.txt');
  });

  it('hoists path from edits[0] to top level and strips it from all edits', () => {
    const input: Record<string, unknown> = {
      edits: [
        { path: '/file.txt', oldText: 'a', newText: 'b' },
        { oldText: 'c', newText: 'd' },
      ],
    };
    expect(hoistEditPath(input)).toBe(true);
    expect(input.path).toBe('/file.txt');
    expect((input.edits as any[])[0].path).toBeUndefined();
    expect((input.edits as any[])[1].path).toBeUndefined();
  });

  it('returns false when edits[0].path is not a string', () => {
    const input: Record<string, unknown> = {
      edits: [{ oldText: 'a', newText: 'b' }],
    };
    expect(hoistEditPath(input)).toBe(false);
    expect('path' in input).toBe(false);
  });

  it('returns false when edits[0] is not an object', () => {
    const input: Record<string, unknown> = {
      edits: ['not an object'],
    };
    expect(hoistEditPath(input)).toBe(false);
  });

  it('returns true for a single edit object with a string path', () => {
    const input: Record<string, unknown> = {
      edits: [{ path: '/f.txt', oldText: 'a' }],
    };
    expect(hoistEditPath(input)).toBe(true);
    expect(input.path).toBe('/f.txt');
  });

  it('returns false for an empty edits array', () => {
    const input: Record<string, unknown> = { edits: [] };
    expect(hoistEditPath(input)).toBe(false);
  });
});

// ─── repairStringifiedEdits (parse guard, plan assumption 3) ──────────

describe('repairStringifiedEdits', () => {
  it('parses a valid JSON array of 2 objects and assigns it (true)', () => {
    const input: Record<string, unknown> = {
      edits: '[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]',
    };
    expect(repairStringifiedEdits(input)).toBe(true);
    expect(input.edits).toEqual([
      { oldText: 'a', newText: 'b' },
      { oldText: 'c', newText: 'd' },
    ]);
  });

  it("parses valid JSON with a nested path — hoisting is the hook's job, not this one", () => {
    const input: Record<string, unknown> = {
      edits: '[{"path":"/f.txt","oldText":"a","newText":"b"}]',
    };
    expect(repairStringifiedEdits(input)).toBe(true);
    expect('path' in input).toBe(false);
    expect((input.edits as any[])[0].path).toBe('/f.txt');
  });

  it('returns false for invalid JSON and leaves the input untouched', () => {
    const input: Record<string, unknown> = { edits: '[{"oldText":"a"' };
    expect(repairStringifiedEdits(input)).toBe(false);
    expect(input.edits).toBe('[{"oldText":"a"');
  });

  it('returns false when the JSON array contains a non-object element', () => {
    const input: Record<string, unknown> = { edits: '[{"oldText":"a"},"junk"]' };
    expect(repairStringifiedEdits(input)).toBe(false);
    expect(input.edits).toBe('[{"oldText":"a"},"junk"]');
  });

  it('returns false when the JSON parses to a non-array (object / scalar / null)', () => {
    for (const raw of ['{"oldText":"a"}', '42', 'null']) {
      const input: Record<string, unknown> = { edits: raw };
      expect(repairStringifiedEdits(input)).toBe(false);
      expect(input.edits).toBe(raw);
    }
  });

  it('returns false when edits is an array already or absent', () => {
    const alreadyArray: Record<string, unknown> = { edits: [{ oldText: 'a' }] };
    expect(repairStringifiedEdits(alreadyArray)).toBe(false);
    const absent: Record<string, unknown> = { path: '/f.txt' };
    expect(repairStringifiedEdits(absent)).toBe(false);
  });
});

// ─── salvageCorruptEdits (S3 shape) ────────────────────────────────────

describe('salvageCorruptEdits', () => {
  it('salvages a cut right after a complete entry: truncation + marker → complete array (true)', () => {
    const input = {
      path: '/f.txt',
      edits: JSON.stringify([{ oldText: 'a', newText: 'b' }]) + THIN_OPEN,
    };
    expect(salvageCorruptEdits(input)).toBe(true);
    expect(input.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
  });

  it('salvages a raw control char inside a value plus truncation after a complete entry (true)', () => {
    const input = {
      path: '/f.txt',
      // raw newline inside the value string, then the marker cut
      edits: '[{"oldText":"a","newText":"b\nz"}' + THIN_OPEN,
    };
    expect(salvageCorruptEdits(input)).toBe(true);
    expect(input.edits).toEqual([{ oldText: 'a', newText: 'b\nz' }]);
  });

  it('returns false when there is no root path (guard), input untouched', () => {
    const input = { edits: '[{"oldText":"a","newText":"b"}' + THIN_OPEN };
    const before = structuredClone(input);
    expect(salvageCorruptEdits(input)).toBe(false);
    expect(input).toEqual(before);
  });

  it('returns false when the edits string already parses (not a corruption case)', () => {
    const input = { path: '/f.txt', edits: '[{"oldText":"a","newText":"b"}]' };
    expect(salvageCorruptEdits(input)).toBe(false);
  });

  it('returns false when edits is not a string', () => {
    const input = { path: '/f.txt', edits: [{ oldText: 'a', newText: 'b' }] };
    expect(salvageCorruptEdits(input)).toBe(false);
  });

  it('returns false when the cut leaves an entry object open (closers cannot repair)', () => {
    const input = {
      path: '/f.txt',
      // cut mid-value → the entry `{` stays open
      edits: '[{"oldText":"a","newText":"bc' + THIN_OPEN,
    };
    expect(salvageCorruptEdits(input)).toBe(false);
  });

  it('returns false when the salvaged array has zero complete entries', () => {
    const input = {
      path: '/f.txt',
      // parses to [{"oldText":"a"}] — no newText → zero complete
      edits: '[{"oldText":"a"}' + THIN_OPEN,
    };
    expect(salvageCorruptEdits(input)).toBe(false);
  });

  it('returns false when the parse yields non-object elements', () => {
    const input = { path: '/f.txt', edits: '[1,2,3' + THIN_OPEN };
    expect(salvageCorruptEdits(input)).toBe(false);
  });

  it('returns false when the tail is not inside an open string/array and the parse fails', () => {
    const input = {
      path: '/f.txt',
      // extra `}` at the end — nothing to close, mid-content breakage
      edits: '[{"oldText":"a","newText":"b"}}]',
    };
    expect(salvageCorruptEdits(input)).toBe(false);
  });
});

// ─── recoverGarbledPath (step 4.3) ──────────────────────────────────────

describe('recoverGarbledPath', () => {
  it('recovers the garbled `path>` value from fixture s4s5[2] (true)', () => {
    const fixture = fixtureGroup('s4s5')[2];
    const input = structuredClone(fixture.args);
    expect(recoverGarbledPath(input)).toBe(true);
    expect(input.path).toBe(fixture.args.edits[0]['path>']);
    expect(input.edits[0]).not.toHaveProperty('path>');
  });

  it('returns false when the garbled key holds a non-string value', () => {
    const input = { edits: [{ oldText: 'a', newText: 'b', 'path>': 42 }] };
    const before = structuredClone(input);
    expect(recoverGarbledPath(input)).toBe(false);
    expect(input).toEqual(before);
  });

  it('returns false when a root path already exists', () => {
    const input = { path: '/root', edits: [{ oldText: 'a', newText: 'b', 'path>': '/x' }] };
    expect(recoverGarbledPath(input)).toBe(false);
  });

  it('returns false when no garbled-path key is present', () => {
    const input = { edits: [{ oldText: 'a', newText: 'b' }] };
    expect(recoverGarbledPath(input)).toBe(false);
  });

  it('returns false when edits is not a non-empty array of objects', () => {
    expect(recoverGarbledPath({ edits: [] })).toBe(false);
    expect(recoverGarbledPath({ edits: 'nope' })).toBe(false);
    expect(recoverGarbledPath({ edits: [42] })).toBe(false);
  });
});

// ─── dropIncompleteEdits (step 4.3) ─────────────────────────────────────

describe('dropIncompleteEdits', () => {
  it('drops the incomplete entry from fixture s6[2], keeps the 3 complete ones (true)', () => {
    const fixture = fixtureGroup('s6')[2];
    const input = structuredClone(fixture.args);
    expect(dropIncompleteEdits(input)).toBe(true);
    expect(input.edits).toEqual([
      fixture.args.edits[0],
      fixture.args.edits[1],
      fixture.args.edits[3],
    ]);
  });

  it('returns false when zero entries are complete (fixture s6[0])', () => {
    const fixture = fixtureGroup('s6')[0];
    const input = structuredClone(fixture.args);
    expect(dropIncompleteEdits(input)).toBe(false);
    expect(input.edits).toEqual(fixture.args.edits);
  });

  it('returns false when all entries are already complete', () => {
    const input = { edits: [{ oldText: 'a', newText: 'b' }] };
    const before = structuredClone(input);
    expect(dropIncompleteEdits(input)).toBe(false);
    expect(input).toEqual(before);
  });

  it('returns false when edits is not a non-empty array of objects', () => {
    expect(dropIncompleteEdits({ edits: [] })).toBe(false);
    expect(dropIncompleteEdits({ edits: 'nope' })).toBe(false);
    expect(dropIncompleteEdits({ edits: [42] })).toBe(false);
  });

  it('treats empty-string oldText as incomplete', () => {
    const input = {
      edits: [
        { oldText: '', newText: 'b' },
        { oldText: 'a', newText: 'b' },
      ],
    };
    expect(dropIncompleteEdits(input)).toBe(true);
    expect(input.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
  });
});

// ─── already-valid args: all three new rules are no-ops ─────────────────

describe('already-valid args (all three new rules no-op)', () => {
  it('returns false for all three and leaves the args untouched', () => {
    const input = { path: '/f.txt', edits: [{ oldText: 'a', newText: 'b' }] };
    expect(salvageCorruptEdits(input)).toBe(false);
    expect(recoverGarbledPath(input)).toBe(false);
    expect(dropIncompleteEdits(input)).toBe(false);
    expect(input.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
    expect(input.path).toBe('/f.txt');
  });
});
