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
} from '../../src/tool-repair';

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

    it('non-validation error text ("Could not find the exact text") → undefined, no log', () => {
      const { api, handlers } = makeMockPi();
      toolRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-n',
          toolName: 'edit',
          input: { path: '/f', edits: [{ oldText: 'x', newText: 'y' }] },
          content: [
            {
              type: 'text',
              text: 'Could not find the exact text in /f. Ensure oldText matches exactly.',
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
