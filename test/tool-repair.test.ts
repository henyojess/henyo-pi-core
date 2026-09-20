import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// getAgentDir is only used when logPath is absent; tests always pass logPath.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/must/not/be/used',
}));

import { toolRepairExtension, resolveToolRepair } from '../src/tool-repair.js';
import {
  hoistEditPath,
  repairStringifiedEdits,
  salvageCorruptEdits,
  recoverGarbledPath,
  dropIncompleteEdits,
} from '../src/tool-repair/rules.js';
import { editLocationFingerprint } from '../src/tool-repair/fingerprint.js';
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
    it('hoists nested path, keeps role/id/non-edit entries, logs fixed', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['message_end'](
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

    it('returns undefined and logs nothing when path is already top-level', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['message_end'](
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

    it('returns undefined for non-assistant messages', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['message_end'](
        { type: 'message_end', message: { role: 'user', content: [] } },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });

    it('returns undefined when the tool call is not edit', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['message_end'](
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

    it('is a no-op when the extension is disabled', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: false, logPath });

      const result = await handlers['message_end'](
        { type: 'message_end', message: assistantMessage() },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });
  });

  describe('message_end (stringified edits)', () => {
    it('stringified edits (no nested path) → array assigned, fixed log with only the parse rule', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['message_end'](
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

    it('stringified edits with nested path → both rules in one record, path at top level', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['message_end'](
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

    it('appends coaching line after the original error and logs failed', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
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

    it('returns undefined for non-validation errors and logs nothing', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
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

    it('returns undefined when the result is not an error', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
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

    it('other tools (write) validation failure → original text + generic line, failed log with the tool name', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const writeError = 'Validation failed for tool "write":\n- content: Required';
      const result = await handlers['tool_result'](
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
      expect(block.text).toContain("the arguments must match the tool's schema exactly");
      // edit-specific line must NOT leak into other tools' coaching.
      expect(block.text).not.toContain('put `path` at the top level next to `edits`');

      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe('write');
      expect(log[0].outcome).toBe('failed');
      expect(log[0].issues).toContain('keys=[');
    });

    it('read validation failure → original text + generic line preserved in order, failed log with tool read', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const readError = 'Validation failed for tool "read":\n- path: Required';
      const result = await handlers['tool_result'](
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

    it('older "Invalid input" signature also gets the edit coaching line (regression)', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const oldError =
        'Invalid input for tool "edit". Fix these issues and retry:\n- path: Required';
      const result = await handlers['tool_result'](
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

    it('content error text ("Could not find the exact text") → coached with content-not-found line, failed log', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'Could not find the exact text in /f. Ensure oldText matches exactly.';
      const result = await handlers['tool_result'](
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
    it('content-not-found (edits[N] variant) → coached line + failed log with the category', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error =
        'Could not find edits[0] in /f. The oldText must match exactly including all whitespace and newlines.';
      const result = await handlers['tool_result'](
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

    it('content-not-unique → coached line + failed log with the category', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'Found 2 occurrences of the text in /f. The text must be unique.';
      const result = await handlers['tool_result'](
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

    it('content-overlap → coached line + failed log with the category', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'edits[0] and edits[1] overlap in /f. Merge them into one edit.';
      const result = await handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-c3',
          toolName: 'edit',
          input: {
            path: '/f',
            edits: [
              { oldText: 'a', newText: 'b' },
              { oldText: 'b', newText: 'c' },
            ],
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

    it('content-identical → coached line + failed log with the category', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'No changes made to /f. The replacement produced identical content.';
      const result = await handlers['tool_result'](
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

    it('content-error text on a non-edit tool (bash) → undefined, no log', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
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

    it('not-found coaching now carries the anti-verbatim-retry prohibition', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const error = 'Could not find the exact text in /f. Ensure oldText matches exactly.';
      const result = await handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-proh',
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
      expect(block.text).toContain('Henyo note: Re-read the file now');
      expect(block.text).toContain(
        'Do not re-emit an oldText that has already failed — it will fail again.',
      );
    });
  });

  describe('tool_result (retriedVerbatim — telemetry v2)', () => {
    const A_IN = { path: '/dir/a.txt', edits: [{ oldText: 'x', newText: 'y' }] };
    const failNotFound = (id: string) => ({
      type: 'tool_result',
      toolCallId: id,
      toolName: 'edit',
      input: A_IN,
      content: [{ type: 'text', text: 'Could not find the exact text in /dir/a.txt: "x".' }],
      isError: true,
      details: undefined,
    });
    const okEdit = (id: string, input: any) => ({
      type: 'tool_result',
      toolCallId: id,
      toolName: 'edit',
      input,
      content: [{ type: 'text', text: 'OK' }],
      isError: false,
      details: undefined,
    });
    const okRead = (id: string) => ({
      type: 'tool_result',
      toolCallId: id,
      toolName: 'read',
      input: { path: '/dir/a.txt' },
      content: [{ type: 'text', text: 'x\nfile content\n' }],
      isError: false,
      details: undefined,
    });

    it('same-fingerprint edit fails twice with no read between → second record has retriedVerbatim', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      await handlers['tool_result'](failNotFound('call-f1'), ctx);
      await handlers['tool_result'](failNotFound('call-f2'), ctx);

      const log = readLog(logPath);
      expect(log).toHaveLength(2);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].retriedVerbatim).toBeUndefined();
      expect(log[1].outcome).toBe('failed');
      expect(log[1].retriedVerbatim).toBe(true);
      expect(log[1].fingerprint).toBe(log[0].fingerprint);
    });

    it('successful read of the file in between → later same-fingerprint failure NOT flagged; the read logs nothing', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      await handlers['tool_result'](failNotFound('call-f1'), ctx);
      await handlers['tool_result'](okRead('call-r1'), ctx);
      await handlers['tool_result'](failNotFound('call-f2'), ctx);

      const log = readLog(logPath);
      // The read itself logs no record (not recovery, not an ok denominator).
      expect(log).toHaveLength(2);
      expect(log.every((r: any) => r.outcome === 'failed')).toBe(true);
      expect(log[0].retriedVerbatim).toBeUndefined();
      expect(log[1].retriedVerbatim).toBeUndefined();
    });

    it('recovery (ok) closes the open failure → later same-fingerprint failure NOT flagged', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      await handlers['tool_result'](failNotFound('call-f1'), ctx);
      await handlers['tool_result'](okEdit('call-ok', A_IN), ctx);
      await handlers['tool_result'](failNotFound('call-f2'), ctx);

      const log = readLog(logPath);
      expect(log.map((r: any) => r.outcome)).toEqual(['failed', 'ok', 'recovered', 'failed']);
      expect(log[3].retriedVerbatim).toBeUndefined();
    });

    it('validation-class failure path also flags the second identical same-file failure', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      // resolvable top-level path (file-scoped semantics) but a validation-class
      // error, so this exercises the generic failure path, not the content rules
      const badInput = { path: '/dir/b.txt', edits: [{ oldText: 'x' }] }; // missing newText
      const failValidation = (id: string) => ({
        type: 'tool_result',
        toolCallId: id,
        toolName: 'edit',
        input: badInput,
        content: [
          {
            type: 'text',
            text: 'Validation failed for tool "edit":\n- edits[0].newText: Required',
          },
        ],
        isError: true,
        details: undefined,
      });

      await handlers['tool_result'](failValidation('call-v1'), ctx);
      await handlers['tool_result'](failValidation('call-v2'), ctx);

      const log = readLog(logPath);
      expect(log).toHaveLength(2);
      expect(log[0].retriedVerbatim).toBeUndefined();
      expect(log[1].retriedVerbatim).toBe(true);
      expect(log[1].fingerprint).toBe(log[0].fingerprint);
    });

    it('successful bash result does not reset retriedVerbatim state (reads only)', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      await handlers['tool_result'](failNotFound('call-f1'), ctx);
      await handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-bash',
          toolName: 'bash',
          input: { command: 'cat /dir/a.txt' },
          content: [{ type: 'text', text: 'x' }],
          isError: false,
          details: undefined,
        },
        ctx,
      );
      await handlers['tool_result'](failNotFound('call-f2'), ctx);

      const log = readLog(logPath);
      expect(log).toHaveLength(2);
      expect(log[1].retriedVerbatim).toBe(true);
    });
  });

  describe('tool_result (unknown tools)', () => {
    it('unquoted "Tool calc not found" → hint lists getActiveTools() in order, failed log unknown-tool', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
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

    it('quoted variant matches; getActiveTools throwing → fallback list, hint still returned', async () => {
      const { api, handlers } = makeMockPi();
      api.getActiveTools = () => {
        throw new Error('nope');
      };
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
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

    it('known-tool error (read ENOENT text) → undefined, no log', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
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

  // Telemetry v2 — the `ok` denominator (plan step 2, assumption A1: edit
  // only). The fallback-harness case (ok + applied together) lives in
  // tool-repair-edit-fallback.test.ts.
  describe('tool_result (ok denominator — telemetry v2)', () => {
    it('successful edit (no pending rewrites) → exactly 1 ok record with the location fingerprint', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const input = { path: '/f.txt', edits: [{ oldText: 'a', newText: 'b' }] };
      const result = await handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-ok',
          toolName: 'edit',
          input,
          content: [{ type: 'text', text: 'OK' }],
          isError: false,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeUndefined();
      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('ok');
      expect(log[0].tool).toBe('edit');
      expect(log[0].model).toBe('qwen3.6-27b');
      expect(log[0].fingerprint).toBe(editLocationFingerprint(input));
    });

    it('successful bash → 0 ok records (edit-only denominator, A1)', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = await handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-bash',
          toolName: 'bash',
          input: { command: 'ls' },
          content: [{ type: 'text', text: 'file1' }],
          isError: false,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeUndefined();
      const log = readLog(logPath);
      expect(log.filter((r) => r.outcome === 'ok')).toHaveLength(0);
    });
  });

  // Telemetry v2 — recovery tracking (plan step 3; A2 per-file, A5 in-memory).
  describe('tool_result (recovery — telemetry v2)', () => {
    const failEdit = (id: string, input: any, text: string) => ({
      type: 'tool_result',
      toolCallId: id,
      toolName: 'edit',
      input,
      content: [{ type: 'text', text }],
      isError: true,
      details: undefined,
    });
    const okEdit = (id: string, input: any) => ({
      type: 'tool_result',
      toolCallId: id,
      toolName: 'edit',
      input,
      content: [{ type: 'text', text: 'OK' }],
      isError: false,
      details: undefined,
    });
    const errNotFound = '/dir/a.txt';
    const A_IN = { path: '/dir/a.txt', edits: [{ oldText: 'x', newText: 'y' }] };
    const B_IN = { path: '/dir/b.txt', edits: [{ oldText: 'x', newText: 'y' }] };

    it('fail(a.txt) → ok(a.txt) → 1 recovered with the failed fp, recoveredBy = ok toolCallId, afterMs ≥ 0', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      await handlers['tool_result'](
        failEdit(
          'call-fail',
          A_IN,
          `Could not find the exact text in ${errNotFound}. The old text must match exactly including all whitespace and newlines.`,
        ),
        ctx,
      );
      await handlers['tool_result'](okEdit('call-ok', A_IN), ctx);

      const log = readLog(logPath);
      const failed = log.filter((r) => r.outcome === 'failed');
      const ok = log.filter((r) => r.outcome === 'ok');
      const recovered = log.filter((r) => r.outcome === 'recovered');
      expect(failed).toHaveLength(1);
      expect(ok).toHaveLength(1);
      expect(recovered).toHaveLength(1);
      expect(recovered[0].fingerprint).toBe(failed[0].fingerprint);
      expect(recovered[0].toolCallId).toBe('call-fail');
      expect(recovered[0].recoveredBy).toBe('call-ok');
      expect(recovered[0].afterMs).toBeGreaterThanOrEqual(0);
      expect(recovered[0].issues).toBe('content-not-found');
    });

    it('fail(a.txt) → ok(b.txt) → 0 recovered; open failure still recoverable by a later ok(a.txt)', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      await handlers['tool_result'](
        failEdit(
          'call-fail',
          A_IN,
          `Could not find the exact text in ${errNotFound}. The old text must match exactly including all whitespace and newlines.`,
        ),
        ctx,
      );
      await handlers['tool_result'](okEdit('call-ok-b', B_IN), ctx);
      expect(readLog(logPath).filter((r) => r.outcome === 'recovered')).toHaveLength(0);

      await handlers['tool_result'](okEdit('call-ok-a', A_IN), ctx);
      const recovered = readLog(logPath).filter((r) => r.outcome === 'recovered');
      expect(recovered).toHaveLength(1);
      expect(recovered[0].recoveredBy).toBe('call-ok-a');
      expect(recovered[0].toolCallId).toBe('call-fail');
    });

    it('fail ×2 (a.txt) → ok(a.txt) → 2 recovered records (FIFO order)', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      await handlers['tool_result'](
        failEdit(
          'call-f1',
          A_IN,
          `Could not find the exact text in ${errNotFound}. The old text must match exactly including all whitespace and newlines.`,
        ),
        ctx,
      );
      await handlers['tool_result'](
        failEdit(
          'call-f2',
          A_IN,
          `Found 2 occurrences of the text in ${errNotFound}. The text must be unique. Please provide more context to make it unique.`,
        ),
        ctx,
      );
      await handlers['tool_result'](okEdit('call-ok', A_IN), ctx);

      const recovered = readLog(logPath).filter((r) => r.outcome === 'recovered');
      expect(recovered).toHaveLength(2);
      expect(recovered.map((r) => r.toolCallId)).toEqual(['call-f1', 'call-f2']);
      expect(recovered.every((r) => r.recoveredBy === 'call-ok')).toBe(true);
    });

    it('failure without a resolvable path → no state pushed (no leak), 0 recovered on a later ok', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      // no top-level path (path nested in edits[0] — validation class)
      const input = { edits: [{ path: '/dir/a.txt', oldText: 'x' }] };
      await handlers['tool_result'](
        failEdit('call-fail', input, 'Validation failed for tool "edit":\n- path: Required'),
        ctx,
      );
      const failed = readLog(logPath).filter((r) => r.outcome === 'failed');
      expect(failed).toHaveLength(1); // still logged — tracking is what is skipped

      await handlers['tool_result'](okEdit('call-ok', A_IN), ctx);
      expect(readLog(logPath).filter((r) => r.outcome === 'recovered')).toHaveLength(0);
    });
  });

  // Telemetry v2 — emission classification (plan step 4; A4: validation-class
  // `failed` records only).
  describe('tool_result (emission — telemetry v2)', () => {
    it('failed edit (validation error, stringified truncated edits) → 1 failed record with emission: truncated + the Step-1 location fingerprint', async () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const input = { path: '/f.txt', edits: '[{"oldText": "abc' };
      const result = await handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-trunc',
          toolName: 'edit',
          input,
          content: [
            {
              type: 'text',
              text: 'Validation failed for tool "edit":\n- edits: Expected array, received string',
            },
          ],
          isError: true,
          details: undefined,
        },
        ctx,
      );

      expect(result).toBeDefined();
      const log = readLog(logPath);
      expect(log).toHaveLength(1);
      expect(log[0].outcome).toBe('failed');
      expect(log[0].emission).toBe('truncated');
      expect(log[0].fingerprint).toBe(editLocationFingerprint(input));
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
      expect(extended.match(/copy edits\[\]\.oldText verbatim from that fresh read/g)).toHaveLength(
        1,
      );
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

    it('trust-result and no-bypass lines appended once each, ordered after read-before-edit', () => {
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
      // Each new line exactly once; pre-existing lines still exactly once.
      expect(extended.match(/trust that result/g)).toHaveLength(1);
      expect(extended.match(/Edit existing files only with the `edit` tool/g)).toHaveLength(1);
      expect(extended).toContain('never via');
      expect(extended.match(/not inside individual edit objects/g)).toHaveLength(1);
      expect(extended.match(/copy edits\[\]\.oldText verbatim from that fresh read/g)).toHaveLength(
        1,
      );
      // Order: path-shape, read-before-edit, trust-result, no-bypass.
      const pos = (needle: string) => extended.indexOf(needle);
      expect(pos('read it immediately before calling edit')).toBeLessThan(pos('trust that result'));
      expect(pos('trust that result')).toBeLessThan(
        pos('Edit existing files only with the `edit` tool'),
      );
    });

    it('trust-result and no-bypass lines are idempotent — second call returns undefined', () => {
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
      expect(first.systemPrompt.match(/trust that result/g)).toHaveLength(1);
      expect(
        first.systemPrompt.match(/Edit existing files only with the `edit` tool/g),
      ).toHaveLength(1);
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
    const salvaged = fixtureGroup('s3').filter((_, i) =>
      OUTCOME_RULES.s3[i].includes('salvage-corrupt-edits'),
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
    expect(args.edits).toEqual([
      fixture.args.edits[0],
      fixture.args.edits[1],
      fixture.args.edits[3],
    ]);
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

  it('logs one fixed record with rule name `salvage-corrupt-edits`', async () => {
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath });

    const result = await handlers['message_end'](
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

  it('logs one fixed record with rule name `recover-garbled-path`', async () => {
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath });

    const result = await handlers['message_end'](
      editMessage({ edits: [{ 'path>': '/f.txt', oldText: 'a', newText: 'b' }] }),
      ctx,
    );
    expect(result).toBeDefined();
    expect(result.message.content[0].arguments.path).toBe('/f.txt');
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].rules).toEqual(['recover-garbled-path']);
  });

  it('logs one fixed record with rule name `drop-incomplete-edits`', async () => {
    const { api, handlers } = makeMockPi();
    toolRepairExtension(api, { enabled: true, logPath });

    const result = await handlers['message_end'](
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
