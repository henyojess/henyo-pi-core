import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// getAgentDir is only used when logPath is absent; tests always pass logPath.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/must/not/be/used',
}));

import {
  editPathRepairExtension,
  hoistEditPath,
  resolveToolRepair,
} from '../../src/tool-repair';

// ─── helpers ───────────────────────────────────────────────────────────

function makeMockPi() {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  const on = vi.fn((event: string, handler: any) => {
    handlers[event] = handler;
  });
  return { api: { on } as any, handlers };
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

describe('editPathRepairExtension hooks', () => {
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
    editPathRepairExtension(api, { enabled: true, logPath });
    expect(handlers['message_end']).toBeDefined();
    expect(handlers['tool_result']).toBeDefined();
    expect(handlers['before_agent_start']).toBeDefined();
    expect(Object.keys(handlers)).toHaveLength(3);
    expect(Object.keys(api).filter((k) => k.startsWith('register'))).toHaveLength(0);
  });

  describe('message_end (repair)', () => {
    it('hoists nested path, keeps role/id/non-edit entries, logs fixed', () => {
      const { api, handlers } = makeMockPi();
      editPathRepairExtension(api, { enabled: true, logPath });

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
      editPathRepairExtension(api, { enabled: true, logPath });

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
      editPathRepairExtension(api, { enabled: true, logPath });

      const result = handlers['message_end'](
        { type: 'message_end', message: { role: 'user', content: [] } },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });

    it('returns undefined when the tool call is not edit', () => {
      const { api, handlers } = makeMockPi();
      editPathRepairExtension(api, { enabled: true, logPath });

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
      editPathRepairExtension(api, { enabled: false, logPath });

      const result = handlers['message_end'](
        { type: 'message_end', message: assistantMessage() },
        ctx,
      );
      expect(result).toBeUndefined();
      expect(readLog(logPath)).toHaveLength(0);
    });
  });

  describe('tool_result (coaching)', () => {
    const validationError = 'Validation failed for tool "edit":\n- path: Required';

    it('appends coaching line after the original error and logs failed', () => {
      const { api, handlers } = makeMockPi();
      editPathRepairExtension(api, { enabled: true, logPath });

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
      editPathRepairExtension(api, { enabled: true, logPath });

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
      editPathRepairExtension(api, { enabled: true, logPath });

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

    it('returns undefined for other tools', () => {
      const { api, handlers } = makeMockPi();
      editPathRepairExtension(api, { enabled: true, logPath });

      const result = handlers['tool_result'](
        {
          type: 'tool_result',
          toolCallId: 'call-1',
          toolName: 'write',
          input: {},
          content: [
            {
              type: 'text',
              text: 'Validation failed for tool "write":\n- path: Required',
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

  describe('before_agent_start (prevention)', () => {
    it('appends the guideline line to the system prompt', () => {
      const { api, handlers } = makeMockPi();
      editPathRepairExtension(api, { enabled: true, logPath });

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
      editPathRepairExtension(api, { enabled: true, logPath });

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
      editPathRepairExtension(api, { enabled: false, logPath });

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
