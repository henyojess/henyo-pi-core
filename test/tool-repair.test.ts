import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// getAgentDir is only used when logPath is absent; tests always pass logPath.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/must/not/be/used',
}));

import {
  toolRepairExtension,
  hoistEditPath,
  repairStringifiedEdits,
  resolveToolRepair,
  salvageCorruptEdits,
  recoverGarbledPath,
  dropIncompleteEdits,
} from '../src/tool-repair.js';
import payloads from './fixtures/edit-failure-payloads.json' with { type: 'json' };

// ─── step-4 fixture helpers ─────────────────────────────────────────────

type FixtureEntry = { model: string; args: Record<string, any> };
const fixtureGroup = (name: string): FixtureEntry[] =>
  (payloads as Record<string, FixtureEntry[]>)[name];

// Degeneration marker built via concatenation so the raw sequence never
// appears as a literal in this source (it triggers parser behavior downstream).
const THIN_OPEN = '<' + 'think' + '>';

// ─── helpers ───────────────────────────────────────────────────────────

function makeMockPi() {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  const on = vi.fn((event: string, handler: any) => {
    handlers[event] = handler;
  });
  const api = {
    on,
    // Default stub — tests override per-case (e.g. the unknown-tool fallback test).
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

const nestedArgs = () => ({
  edits: [{ path: '/file.txt', oldText: 'a', newText: 'b' }],
});

const editToolCall = () => ({
  type: 'toolCall',
  id: 'call-1',
  name: 'edit',
  arguments: nestedArgs(),
});

const assistantMessage = () => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: 'working…' }, editToolCall()],
});

const ctx = { model: { id: 'qwen3.6-27b' } };

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

  it('parses valid JSON with a nested path — hoisting is the hook\'s job, not this one', () => {
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

// ─── resolveToolRepair truth table ────────────────────────────────────

describe('resolveToolRepair', () => {
  it('defaults to true when toolRepair is unset', () => {
    expect(resolveToolRepair({})).toBe(true);
  });

  it('returns false when toolRepair is false', () => {
    expect(resolveToolRepair({ toolRepair: false })).toBe(false);
  });

  it('returns true when toolRepair is true', () => {
    expect(resolveToolRepair({ toolRepair: true })).toBe(true);
  });
});

// ─── extension hooks ───────────────────────────────────────────────────

describe('toolRepairExtension hooks', () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tool-repair-test-'));
    logPath = join(tmp, 'tool-repair.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('registers exactly the three event hooks and no tools', () => {
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath });
    expect(handlers['message_end']).toBeDefined();
    expect(handlers['tool_result']).toBeDefined();
    expect(handlers['before_agent_start']).toBeDefined();
    expect(Object.keys(handlers)).toHaveLength(3);
    expect(Object.keys(api).filter((k) => k.startsWith('register'))).toHaveLength(0);
  });

  describe('message_end (repair)', () => {
    it('hoists nested path, keeps role/id/non-edit entries, logs fixed', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['message_end'](
        { type: 'message_end', message: assistantMessage() },
        ctx,
      );

      expect(result).toBeDefined();
      const message = result.message;
      expect(message.role).toBe('assistant');
      expect(message.content[0]).toEqual({ type: 'text', text: 'working…' });
      const fixed = message.content[1];
      expect(fixed.id).toBe('call-1');
      expect(fixed.name).toBe('edit');
      expect(fixed.arguments.path).toBe('/file.txt');
      expect(fixed.arguments.edits[0].path).toBeUndefined();

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe('edit');
      expect(log[0].outcome).toBe('fixed');
      expect(log[0].rules).toEqual(['extract-path']);
      expect(log[0].model).toBe('qwen3.6-27b');
      expect(log[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(log[0].fingerprint).toMatch(/^[0-9a-f]{8}$/);
    });

    it('returns undefined and logs nothing when path is already top-level', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['message_end'](
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call-2',
                name: 'edit',
                arguments: {
                  path: '/f.txt',
                  edits: [{ oldText: 'a', newText: 'b' }],
                },
              },
            ],
          },
        },
        ctx,
      );

      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });

    it('returns undefined for non-assistant messages', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['message_end'](
        { type: 'message_end', message: { role: 'user', content: [] } },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });

    it('returns undefined when the tool call is not edit', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['message_end'](
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'x' },
              {
                type: 'toolCall',
                id: 'call-3',
                name: 'write',
                arguments: { path: '/f', content: 'hello' },
              },
            ],
          },
        },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });

    it('is a no-op when the extension is disabled', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: false, logPath });

      const result = handlers['message_end'](
        { type: 'message_end', message: assistantMessage() },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });
  });

  describe('message_end (stringified edits)', () => {
    it('stringified edits (no nested path) → array assigned, fixed log with only the parse rule', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['message_end'](
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'working…' },
              {
                type: 'toolCall',
                id: 'call-s1',
                name: 'edit',
                arguments: { edits: '[{"oldText":"a","newText":"b"}]' },
              },
            ],
          },
        },
        ctx,
      );

      expect(result).toBeDefined();
      const message = result.message;
      expect(message.content[0]).toEqual({ type: 'text', text: 'working…' });
      const fixed = message.content[1];
      expect(fixed.name).toBe('edit');
      expect(fixed.arguments.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
      expect('path' in fixed.arguments).toBe(false);

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe('edit');
      expect(log[0].outcome).toBe('fixed');
      expect(log[0].rules).toEqual(['parse-stringified-edits']);
      expect(log[0].model).toBe('qwen3.6-27b');
    });

    it('stringified edits with nested path → both rules in one record, path at top level', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['message_end'](
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call-s2',
                name: 'edit',
                arguments: { edits: '[{"path":"/f.txt","oldText":"a","newText":"b"}]' },
              },
            ],
          },
        },
        ctx,
      );

      expect(result).toBeDefined();
      const fixed = result.message.content[0];
      expect(fixed.arguments.path).toBe('/f.txt');
      expect(fixed.arguments.edits).toEqual([{ oldText: 'a', newText: 'b' }]);

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('fixed');
      expect(log[0].rules).toEqual(['parse-stringified-edits', 'extract-path']);
    });
  });

  describe('tool_result (coaching)', () => {
    const validationError = 'Validation failed for tool "edit":\n- path: Required';

    it('appends coaching line after the original error and logs failed', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          toolName: 'edit',
          input: { edits: [{ path: '/file.txt', oldText: 'a' }] },
          content: [{ type: 'text', text: validationError }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.type).toBe('text');
      expect(block.text).toContain(validationError);
      expect(block.text).toContain('Henyo note:');
      expect(block.text).toContain('put `path` at the top level next to `edits`');
      expect(block.text.startsWith(validationError)).toBe(true);

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toContain('keys=[');
      expect(log[0].issues).toContain('edits=');
      expect(log[0].model).toBe('qwen3.6-27b');
    });

    it('returns undefined for non-validation errors and logs nothing', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          toolName: 'edit',
          input: { path: '/f', edits: [] },
          content: [{ type: 'text', text: 'File not found: /f' }],
          isError: true,
          details: undefined,
        },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });

    it('returns undefined when the result is not an error', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          toolName: 'edit',
          input: { path: '/f', edits: [{ oldText: 'a', newText: 'b' }] },
          content: [{ type: 'text', text: 'OK' }],
          isError: false,
          details: undefined,
        },
        ctx,
      );
      expect(result).toBeUndefined();
    });

    it('other tools (write) validation failure → original text + generic line, failed log with the tool name', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const writeError = 'Validation failed for tool "write":\n- content: Required';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-w',
          toolName: 'write',
          input: { path: '/f' },
          content: [{ type: 'text', text: writeError }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text).toContain(writeError);
      expect(block.text.startsWith(writeError)).toBe(true);
      expect(block.text).toContain('the arguments must match the tool\'s schema exactly');
      // edit-specific line must NOT leak into other tools' coaching.
      expect(block.text).not.toContain('put `path` at the top level next to `edits`');

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe('write');
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toContain('keys=[');
    });

    it('read validation failure → original text + generic line preserved in order, failed log with tool read', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const readError = 'Validation failed for tool "read":\n- path: Required';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-r',
          toolName: 'read',
          input: { path: 42 },
          content: [{ type: 'text', text: readError }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text).toContain(readError);
      expect(block.text).toContain('Henyo note: the arguments must match the tool');
      // Order: original error first, generic line after.
      expect(block.text.indexOf(readError)).toBeLessThan(block.text.indexOf('Henyo note:'));

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe('read');
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toContain('keys=[');
      expect(log[0].issues).toContain('path');
    });

    it('older "Invalid input" signature also gets the edit coaching line (regression)', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const oldError = 'Invalid input for tool "edit". Fix these issues and retry:\n- path: Required';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-o',
          toolName: 'edit',
          input: { edits: [] },
          content: [{ type: 'text', text: oldError }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text).toContain(oldError);
      expect(block.text).toContain('put `path` at the top level next to `edits`');
      // edit keeps its own line — no generic line for edit.
      expect(block.text).not.toContain("the arguments must match the tool's schema");

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe('edit');
    });

    it('content error text ("Could not find the exact text") → coached with content-not-found line, failed log', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'Could not find the exact text in /f. Ensure oldText matches exactly.';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-n',
          toolName: 'edit',
          input: { path: '/f', edits: [{ oldText: 'x', newText: 'y' }] },
          content: [{ type: 'text', text: error }],
          isError: true,
          details: undefined,
        },
        ctx,
      );
      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text.startsWith(error)).toBe(true);
      expect(block.text).toContain('Henyo note: Re-read the file now');

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toBe('content-not-found');
    });
  });

  describe('tool_result (content coaching)', () => {
    it('content-not-found (edits[N] variant) → coached line + failed log with the category', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error =
        'Could not find edits[0] in /f. The oldText must match exactly including all whitespace and newlines.';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-c1',
          toolName: 'edit',
          input: { path: '/f', edits: [{ oldText: 'x', newText: 'y' }] },
          content: [{ type: 'text', text: error }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text.startsWith(error)).toBe(true);
      expect(block.text).toContain('Henyo note: Re-read the file now');

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toBe('content-not-found');
    });

    it('content-not-unique → coached line + failed log with the category', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'Found 2 occurrences of the text in /f. The text must be unique.';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-c2',
          toolName: 'edit',
          input: { path: '/f', edits: [{ oldText: 'x', newText: 'y' }] },
          content: [{ type: 'text', text: error }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text.startsWith(error)).toBe(true);
      expect(block.text).toContain('Henyo note: The text occurs more than once');

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toBe('content-not-unique');
    });

    it('content-overlap → coached line + failed log with the category', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'edits[0] and edits[1] overlap in /f. Merge them into one edit.';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-c3',
          toolName: 'edit',
          input: {
            path: '/f',
            edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'b', newText: 'c' }],
          },
          content: [{ type: 'text', text: error }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text.startsWith(error)).toBe(true);
      expect(block.text).toContain('Henyo note: The two edit regions overlap');

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toBe('content-overlap');
    });

    it('content-identical → coached line + failed log with the category', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'No changes made to /f. The replacement produced identical content.';
      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-c4',
          toolName: 'edit',
          input: { path: '/f', edits: [{ oldText: 'x', newText: 'x' }] },
          content: [{ type: 'text', text: error }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text.startsWith(error)).toBe(true);
      expect(block.text).toContain('Henyo note: newText equals oldText');

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toBe('content-identical');
    });

    it('content-error text on a non-edit tool (bash) → undefined, no log', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-c5',
          toolName: 'bash',
          input: { command: 'echo x' },
          content: [
            {
              type: 'text',
              text: 'Could not find edits[0] in /f. The oldText must match exactly.',
            },
          ],
          isError: true,
          details: undefined,
        },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });
  });

  describe('tool_result (unknown tools)', () => {
    it('unquoted "Tool calc not found" → hint lists getActiveTools() in order, failed log unknown-tool', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-u1',
          toolName: 'calc',
          input: { expression: '1+1' },
          content: [{ type: 'text', text: 'Tool calc not found' }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text).toContain('Tool calc not found');
      expect(block.text).toContain(
        'Henyo note: no such tool. Available tools: bash, read, edit, write — re-emit the call with one of those.',
      );

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toBe('unknown-tool');
      expect(log[0].tool).toBe('calc');
    });

    it('quoted variant matches; getActiveTools throwing → fallback list, hint still returned', () => {
      const { api, handlers } = makeMockPi();
      api.getActiveTools = () => {
        throw new Error('nope');
      };
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-u2',
          toolName: 'calc',
          input: {},
          content: [{ type: 'text', text: 'Tool "calc" not found' }],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const [block] = result.content;
      expect(block.text).toContain('Tool "calc" not found');
      expect(block.text).toContain(
        'Available tools: bash, read, edit, write, grep, find, ls — re-emit the call with one of those.',
      );

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].issues).toBe('unknown-tool');
    });

    it('known-tool error (read ENOENT text) → undefined, no log', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-k',
          toolName: 'read',
          input: { path: '/missing.txt' },
          content: [
            { type: 'text', text: "ENOENT: no such file or directory, open '/missing.txt'" },
          ],
          isError: true,
          details: undefined,
        },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });
  });

  describe('before_agent_start (prevention)', () => {
    it('appends the guideline line to the system prompt', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['before_agent_start']({
        type: 'before_agent_start',
        prompt: 'do it',
        systemPrompt: 'base system prompt',
        systemPromptOptions: {},
      });

      expect(result).toBeDefined();
      expect(result.systemPrompt).toContain('base system prompt');
      expect(result.systemPrompt).toContain(
        'put `path` at the top level of the arguments, next to `edits`',
      );
    });

    it('is idempotent — second call with the same prompt returns undefined', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const first = handlers['before_agent_start']({
        type: 'before_agent_start',
        prompt: 'p',
        systemPrompt: 'base',
        systemPromptOptions: {},
      });
      const second = handlers['before_agent_start']({
        type: 'before_agent_start',
        prompt: 'p',
        systemPrompt: first.systemPrompt,
        systemPromptOptions: {},
      });

      expect(second).toBeUndefined();
      const line = 'not inside individual edit objects';
      const matches = first.systemPrompt.match(new RegExp(line, 'g')) ?? [];
      expect(matches).toHaveLength(1);
    });

    it('appends the read-before-edit line once, existing PROMPT_LINE still present', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['before_agent_start']({
        type: 'before_agent_start',
        prompt: 'p',
        systemPrompt: 'base system prompt',
        systemPromptOptions: {},
      });

      expect(result).toBeDefined();
      const extended = result.systemPrompt;
      expect(extended).toContain('put `path` at the top level of the arguments, next to `edits`');
      expect(extended).toContain('read it immediately before calling edit');
      // Each line exactly once.
      expect(extended.match(/not inside individual edit objects/g)).toHaveLength(1);
      expect(extended.match(/copy edits\[\]\.oldText verbatim from that fresh read/g)).toHaveLength(1);
      // New line appended after the existing one.
      expect(extended.indexOf('next to `edits`')).toBeLessThan(
        extended.indexOf('read it immediately before calling edit'),
      );
    });

    it('read-before-edit line is idempotent — second invocation adds nothing', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const first = handlers['before_agent_start']({
        type: 'before_agent_start',
        prompt: 'p',
        systemPrompt: 'base',
        systemPromptOptions: {},
      });
      const second = handlers['before_agent_start']({
        type: 'before_agent_start',
        prompt: 'p',
        systemPrompt: first.systemPrompt,
        systemPromptOptions: {},
      });

      expect(second).toBeUndefined();
      expect(first.systemPrompt).toMatch(/copy edits\[\]\.oldText verbatim from that fresh read/);
    });

    it('returns undefined when the extension is disabled', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: false, logPath });

      const result = handlers['before_agent_start']({
        type: 'before_agent_start',
        prompt: 'p',
        systemPrompt: 'base',
        systemPromptOptions: {},
      });
      expect(result).toBeUndefined();
    });
  });
});

// ─── salvageCorruptEdits (step 4.2) ─────────────────────────────────────

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
    expect(input.edits).toEqual([fixture.args.edits[0], fixture.args.edits[1], fixture.args.edits[3]]);
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
    const input = { edits: [{ oldText: '', newText: 'b' }, { oldText: 'a', newText: 'b' }] };
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

// ─── fixture-driven outcome table (step 4.5) ────────────────────────────
// Recorded outcome of the full 5-rule chain on the 24 S3/S4/S5/S6 fixtures
// (exact-transform simulation, plan step 4):
//  - s3 (13): ALL untouched — 2 guard-rejected (no root path: idx 4, 5),
//    11 unrepairable (cut mid-entry leaves the entry object open; mid-content
//    breakage). Salvage count: 0 of 13.
//  - s4s5 (6): [2] recover-garbled-path, [3] + [4] extract-path (pre-existing
//    rule), [0], [1], [5] untouched.
//  - s6 (5): [2] drop-incomplete-edits (4 → 3 entries), [0], [1], [3], [4]
//    untouched.
const OUTCOME_RULES: Record<string, string[][]> = {
  s3: [[], [], [], [], [], [], [], [], [], [], [], [], []],
  s4s5: [[], [], ['recover-garbled-path'], ['extract-path'], ['extract-path'], []],
  s6: [[], [], ['drop-incomplete-edits'], [], []],
};

function runRepairChain(args: Record<string, any>): string[] {
  const rules: string[] = [];
  if (repairStringifiedEdits(args)) rules.push('parse-stringified-edits');
  if (hoistEditPath(args)) rules.push('extract-path');
  if (salvageCorruptEdits(args)) rules.push('salvage-corrupt-edits');
  if (recoverGarbledPath(args)) rules.push('recover-garbled-path');
  if (dropIncompleteEdits(args)) rules.push('drop-incomplete-edits');
  return rules;
}

describe('fixture-driven outcome table (24 S3/S4/S5/S6 payloads)', () => {
  const groups: Array<[string, string[]]> = [
    ['s3', ['s3']],
    ['s4s5', ['s4s5']],
    ['s6', ['s6']],
  ];

  for (const [group] of groups) {
    const entries = fixtureGroup(group);
    entries.forEach((fixture, i) => {
      it(`${group}[${i}] (${fixture.model}): final args match the recorded outcome`, () => {
        const expectedRules = OUTCOME_RULES[group][i];
        const args = structuredClone(fixture.args);
        const fired = runRepairChain(args);
        expect(fired).toEqual(expectedRules);
        if (expectedRules.length === 0) {
          // zero false positives: untouched fixtures stay byte-identical
          expect(args).toEqual(structuredClone(fixture.args));
        }
      });
    });
  }

  it('records the salvage count: 0 of 13 S3 fixtures salvage under the confirmed closers', () => {
    const salvaged = fixtureGroup('s3').filter(
      (_, i) => OUTCOME_RULES.s3[i].includes('salvage-corrupt-edits'),
    ).length;
    expect(salvaged).toBe(0);
  });

  it('s4s5[2]: the garbled `path>` value moves to the root and the key is deleted', () => {
    const fixture = fixtureGroup('s4s5')[2];
    const args = structuredClone(fixture.args);
    runRepairChain(args);
    expect(args.path).toBe(fixture.args.edits[0]['path>']);
    expect(args.edits[0]).toEqual(
      Object.fromEntries(Object.entries(fixture.args.edits[0]).filter(([k]) => k !== 'path>')),
    );
  });

  it('s4s5[3] and s4s5[4]: the nested `path` hoists to the root (pre-existing extract-path)', () => {
    for (const i of [3, 4]) {
      const fixture = fixtureGroup('s4s5')[i];
      const args = structuredClone(fixture.args);
      runRepairChain(args);
      expect(args.path).toBe(fixture.args.edits[0].path);
      expect(args.edits[0]).not.toHaveProperty('path');
      expect(args.edits).toHaveLength(fixture.args.edits.length);
    }
  });

  it('s6[2]: the incomplete entry (index 2, missing oldText) drops; the 3 complete ones keep order', () => {
    const fixture = fixtureGroup('s6')[2];
    const args = structuredClone(fixture.args);
    runRepairChain(args);
    expect(args.path).toBe(fixture.args.path);
    expect(args.edits).toEqual([fixture.args.edits[0], fixture.args.edits[1], fixture.args.edits[3]]);
  });
});

// ─── message_end telemetry for the step-4 rules ─────────────────────────

describe('message_end telemetry for the step-4 rules', () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tool-repair-test-'));
    logPath = join(tmp, 'tool-repair.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const editMessage = (args: Record<string, any>) => ({
    type: 'message_end',
    message: {
      role: 'assistant' as const,
      content: [{ type: 'toolCall' as const, id: 'call-1', name: 'edit', arguments: args }],
    },
  });

  it('logs one fixed record with rule name `salvage-corrupt-edits`', () => {
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath });

    const result = handlers['message_end'](
      editMessage({
        path: '/f.txt',
        edits: JSON.stringify([{ oldText: 'a', newText: 'b' }]) + THIN_OPEN,
      }),
      ctx,
    );
    expect(result).toBeDefined();
    expect(result.message.content[0].arguments.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].outcome).toBe('fixed');
    expect(log[0].rules).toEqual(['salvage-corrupt-edits']);
  });

  it('logs one fixed record with rule name `recover-garbled-path`', () => {
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath });

    const result = handlers['message_end'](
      editMessage({ edits: [{ 'path>': '/f.txt', oldText: 'a', newText: 'b' }] }),
      ctx,
    );
    expect(result).toBeDefined();
    expect(result.message.content[0].arguments.path).toBe('/f.txt');
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].rules).toEqual(['recover-garbled-path']);
  });

  it('logs one fixed record with rule name `drop-incomplete-edits`', () => {
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath });

    const result = handlers['message_end'](
      editMessage({
        path: '/f.txt',
        edits: [{ oldText: 'a', newText: 'b' }, { newText: 'c' }],
      }),
      ctx,
    );
    expect(result).toBeDefined();
    expect(result.message.content[0].arguments.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].rules).toEqual(['drop-incomplete-edits']);
  });
});
