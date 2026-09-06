import { describe, it, expect, vi } from 'vitest';
import { compactionRetryExtension } from '../src/compaction-retry.js';

// Mock @earendil-works/pi-coding-agent (the ported module is the only
// importer in this graph — no getAgentDir needed).
// convertToLlm: identity. serializeConversation: concat text blocks —
// the tests only need deterministic conversation text.
vi.mock('@earendil-works/pi-coding-agent', () => ({
  convertToLlm: (msgs: any[]) => msgs,
  serializeConversation: (msgs: any[]) =>
    msgs
      .map((m: any) =>
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('\n'),
      )
      .join('\n'),
}));

const PLAIN_TEXT_RULE =
  'Output plain markdown text only. Do NOT output tool calls, JSON tool blocks, or anything that looks like a tool invocation. Never continue the conversation.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stub pi: one handler slot per event (pattern from index.test.ts). */
function createStubPi() {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    handlers,
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
}

const textBlock = (text: string) => ({ type: 'text', text });
const toolCallBlock = { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: {} };
const USAGE = { input: 10, output: 20 };

function assistantResponse(
  content: any[],
  overrides: { stopReason?: string; usage?: Record<string, number> } = {},
) {
  return {
    role: 'assistant',
    content,
    api: 'stub',
    provider: 'stub',
    model: 'stub',
    usage: overrides.usage ?? USAGE,
    stopReason: overrides.stopReason ?? 'stop',
  };
}

interface MakeCtxOpts {
  model?: any;
  messages?: any[];
  turnPrefix?: any[];
  previousSummary?: string;
  aborted?: boolean;
}

/** Handler + ctx pair with a mocked modelRegistry.complete. */
function makeHandler(opts: MakeCtxOpts = {}) {
  const stub = createStubPi();
  compactionRetryExtension(stub as any);
  const handler = stub.handlers.get('session_before_compact');
  expect(handler).toBeTypeOf('function');
  const complete = vi.fn();
  // Duck-typed AbortSignal — the handler only reads `signal.aborted`.
  const signal: { aborted: boolean } = { aborted: Boolean(opts.aborted) };
  const event = {
    preparation: {
      messagesToSummarize: opts.messages ?? [
        { role: 'user', content: [textBlock('hello')] },
        { role: 'assistant', content: [textBlock('hi there')] },
      ],
      turnPrefixMessages: opts.turnPrefix ?? [],
      firstKeptEntryId: 'entry-1',
      tokensBefore: 1000,
      previousSummary: opts.previousSummary,
    },
    signal,
  };
  const ctx = {
    // 'in' (not ??) so an explicit `model: undefined` survives (no-model case)
    model: 'model' in opts ? opts.model : { id: 'stub-model' },
    modelRegistry: { complete },
    ui: { notify: vi.fn() },
  };
  return {
    run: () => Promise.resolve(handler!(event, ctx)),
    complete,
    ui: ctx.ui,
    signal,
  };
}

/** User text of the n-th (1-based) complete() call. */
function userText(complete: any, n: number): string {
  const [, context] = complete.mock.calls[n - 1] as [any, any, any];
  return context.messages[0].content[0].text;
}

/** Options of the n-th (1-based) complete() call. */
function options(complete: any, n: number): any {
  return (complete.mock.calls[n - 1] as [any, any, any])[2];
}

describe('compaction-retry (src/compaction-retry.ts)', () => {
  it('registers a session_before_compact handler', () => {
    const stub = createStubPi();
    compactionRetryExtension(stub as any);
    expect(stub.handlers.has('session_before_compact')).toBe(true);
  });

  it('clean summary on attempt 1 → returns compaction result, complete called once', async () => {
    const { run, complete } = makeHandler();
    complete.mockResolvedValueOnce(assistantResponse([textBlock('## Goal\ndone')]));
    const result = await run();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      compaction: {
        summary: '## Goal\ndone',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 1000,
        usage: USAGE,
      },
    });
  });

  it('attempt 1 toolCall block → retry; attempt 2 clean → success with tool-call repair note', async () => {
    const { run, complete } = makeHandler();
    complete
      .mockResolvedValueOnce(assistantResponse([toolCallBlock, textBlock('partial')]))
      .mockResolvedValueOnce(assistantResponse([textBlock('## Goal\nclean')]));
    const result = await run();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result?.compaction?.summary).toBe('## Goal\nclean');
    expect(userText(complete, 1)).not.toContain('contained tool calls');
    expect(userText(complete, 2)).toContain(
      'Your previous response contained tool calls, which is forbidden here.',
    );
    expect(userText(complete, 2)).toContain(PLAIN_TEXT_RULE);
    expect(userText(complete, 2)).toContain('Respond again with ONLY the summary document.');
  });

  it('attempt 1 empty text → retry with empty-response repair note', async () => {
    const { run, complete } = makeHandler();
    complete
      .mockResolvedValueOnce(assistantResponse([]))
      .mockResolvedValueOnce(assistantResponse([textBlock('## Goal\nclean')]));
    const result = await run();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result?.compaction?.summary).toBe('## Goal\nclean');
    expect(userText(complete, 2)).toContain('Your previous response contained no text.');
    expect(userText(complete, 2)).toContain(PLAIN_TEXT_RULE);
  });

  it('attempt 1 stopReason "length" → retry with conciseness repair note', async () => {
    const { run, complete } = makeHandler();
    complete
      .mockResolvedValueOnce(assistantResponse([textBlock('truncated')], { stopReason: 'length' }))
      .mockResolvedValueOnce(assistantResponse([textBlock('## Goal\nclean')]));
    await run();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(userText(complete, 2)).toContain(
      'Your previous response was truncated before completion. Write a more concise summary and make sure it completes.',
    );
  });

  it('attempt 1 complete throws → retry with the error message in the repair note', async () => {
    const { run, complete } = makeHandler();
    complete
      .mockRejectedValueOnce(new Error('API 500: upstream timeout'))
      .mockResolvedValueOnce(assistantResponse([textBlock('## Goal\nclean')]));
    const result = await run();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result?.compaction?.summary).toBe('## Goal\nclean');
    expect(userText(complete, 2)).toContain(
      'Your previous response could not be processed (API 500: upstream timeout).',
    );
    expect(userText(complete, 2)).toContain(PLAIN_TEXT_RULE);
  });

  it('all 3 attempts toolCall → returns undefined (pi default fallback), 3 calls, final notify error', async () => {
    const { run, complete, ui } = makeHandler();
    complete.mockResolvedValue(assistantResponse([toolCallBlock]));
    const result = await run();
    expect(result).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(3);
    const [msg, level] = ui.notify.mock.calls[ui.notify.mock.calls.length - 1];
    expect(level).toBe('error');
    expect(msg).toBe(
      'Compaction: giving up after 3 attempts. Try /compact again, or /tree to jump to an earlier point.',
    );
  });

  it('all 3 attempts error → final notify includes the last error', async () => {
    const { run, complete, ui } = makeHandler();
    complete.mockRejectedValue(new Error('boom'));
    const result = await run();
    expect(result).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(3);
    const [msg, level] = ui.notify.mock.calls[ui.notify.mock.calls.length - 1];
    expect(level).toBe('error');
    expect(msg).toContain('last error: boom');
  });

  it('signal.aborted before the loop → no complete calls, returns undefined', async () => {
    const { run, complete } = makeHandler({ aborted: true });
    const result = await run();
    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('ctx.model undefined → no-op (no complete calls)', async () => {
    const { run, complete } = makeHandler({ model: undefined });
    const result = await run();
    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('messagesToSummarize + turnPrefixMessages both empty → no-op', async () => {
    const { run, complete } = makeHandler({ messages: [], turnPrefix: [] });
    const result = await run();
    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('previousSummary provided → call 1 user text has <previous-summary> block + merge instruction', async () => {
    const { run, complete } = makeHandler({ previousSummary: '## Goal\nold goal' });
    complete.mockResolvedValueOnce(assistantResponse([textBlock('merged')]));
    const result = await run();
    expect(result?.compaction?.summary).toBe('merged');
    const text = userText(complete, 1);
    expect(text).toContain(
      'Update this existing structured summary with the new conversation above.',
    );
    expect(text).toContain('<previous-summary>\n## Goal\nold goal\n</previous-summary>');
  });

  it('option contract: every call gets maxTokens 17000, cacheRetention none, reasoning off, signal, string sessionId', async () => {
    const { run, complete, signal } = makeHandler();
    complete
      .mockResolvedValueOnce(assistantResponse([toolCallBlock]))
      .mockResolvedValueOnce(assistantResponse([textBlock('clean')]));
    await run();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][0]).toEqual({ id: 'stub-model' }); // model passed through
    for (let n = 1; n <= complete.mock.calls.length; n++) {
      const opts = options(complete, n);
      expect(opts.maxTokens).toBe(17000);
      expect(opts.cacheRetention).toBe('none');
      expect(opts.reasoning).toBe('off');
      expect(opts.sessionId).toBeTypeOf('string');
      expect(opts.sessionId).toMatch(UUID_RE);
      expect(opts.signal).toBe(signal); // the event's signal, every call
      expect(opts.signal.aborted).toBe(false);
    }
    // fresh sessionId per call
    expect(options(complete, 1).sessionId).not.toBe(options(complete, 2).sessionId);
  });

  it('system prompt carries the plain-text rule verbatim (prompt-drift guard)', async () => {
    const { run, complete } = makeHandler();
    complete.mockResolvedValueOnce(assistantResponse([textBlock('clean')]));
    await run();
    const [, context] = complete.mock.calls[0] as [any, any, any];
    expect(context.systemPrompt).toContain(PLAIN_TEXT_RULE);
    expect(context.systemPrompt).toBe(
      `You are a conversation summarizer. ${PLAIN_TEXT_RULE} Your only output is the summary document itself.`,
    );
    // the user prompt carries the conversation + the exact structured format
    expect(userText(complete, 1)).toContain('<conversation>\nhello\nhi there\n</conversation>');
    expect(userText(complete, 1)).toContain('## Goal');
    expect(userText(complete, 1)).toContain(PLAIN_TEXT_RULE);
  });
});
