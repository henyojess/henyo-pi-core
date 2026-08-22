import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @earendil-works/pi-coding-agent (types only are used by footer.ts,
// but the pattern matches the rest of the suite)
vi.mock('@earendil-works/pi-coding-agent', () => ({}));

import { FooterFactory } from '../../src/footer';

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, '');

interface CtxOpts {
  name?: string | undefined;
  model?: string;
  reasoning?: boolean;
  level: string;
  usage?: { tokens: number | null; percent: number | null; contextWindow: number };
}

function makeCtx(opts: CtxOpts) {
  return {
    model: { name: opts.model ?? 'qwen3.8-27b', reasoning: opts.reasoning ?? true },
    // Note: the component reads the level via the 5th factory arg (getter);
    // this fn is kept for harness fidelity to ExtensionContext.
    getThinkingLevel: vi.fn(() => opts.level),
    sessionManager: {
      getCwd: () => '/home/u/pi/proj',
      getSessionName: vi.fn(() => opts.name),
    },
    getContextUsage: vi.fn(
      () => opts.usage ?? { tokens: 84000, percent: 42, contextWindow: 200000 },
    ),
  };
}

function render(opts: CtxOpts = { level: 'xhigh' }, width = 100, theme?: any) {
  process.env.HOME = '/home/u';
  const t = theme ?? { fg: (_c: string, s: string) => s };
  const footerData = {
    getGitBranch: () => 'main',
    onBranchChange: () => () => {},
    getExtensionStatuses: () => (opts as any)._statuses ?? new Map(),
    getAvailableProviderCount: () => 1,
  };
  const tui = { requestRender: vi.fn() };
  const comp: any = FooterFactory(tui, t, footerData, makeCtx(opts), () => opts.level);
  return comp.render(width);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('footer v2 line 1', () => {
  it('renders no name prefix when getSessionName() returns undefined', () => {
    const line = strip(render({ level: 'xhigh' })[0]);
    expect(line.startsWith('qwen3.8-27b(xhi)')).toBe(true);
  });

  it("renders no name prefix when getSessionName() returns ''", () => {
    const line = strip(render({ level: 'xhigh', name: '' })[0]);
    expect(line.startsWith('qwen3.8-27b(xhi)')).toBe(true);
  });

  it('renders a name• prefix (bright) when a name is set', () => {
    const line = strip(render({ level: 'xhigh', name: 'myproj' })[0]);
    expect(line).toBe('myproj•qwen3.8-27b(xhi)•42%/84k•/~/pi/proj(main)');

    // Explicit color check: name is bright ('text'), model is dim
    const themed = render({ level: 'xhigh', name: 'myproj' }, 100, {
      fg: (c: string, s: string) =>
        c === 'text' ? `\x1b[1m${s}\x1b[0m` : c === 'dim' ? `\x1b[90m${s}\x1b[0m` : s,
    })[0];
    expect(themed.startsWith('\x1b[1mmyproj\x1b[0m•')).toBe(true);
    expect(themed).toContain('•\x1b[90mqwen3.8-27b(xhi)\x1b[0m•');
  });

  it('appends (xhi) for level xhigh on a reasoning model', () => {
    const line = strip(render({ level: 'xhigh' })[0]);
    expect(line.startsWith('qwen3.8-27b(xhi)')).toBe(true);
  });

  it('appends (low) for level low on a reasoning model', () => {
    const line = strip(render({ level: 'low' })[0]);
    expect(line.startsWith('qwen3.8-27b(low)')).toBe(true);
  });

  it('omits the suffix for level off', () => {
    const line = strip(render({ level: 'off' })[0]);
    expect(line.startsWith('qwen3.8-27b•')).toBe(true);
  });

  it('omits the suffix for non-reasoning models at any level', () => {
    const line = strip(render({ level: 'xhigh', reasoning: false })[0]);
    expect(line.startsWith('qwen3.8-27b•')).toBe(true);
  });

  it('joins all segments with • and has no space-adjacent separators', () => {
    const line = strip(render({ level: 'xhigh', name: 'myproj' })[0]);
    expect(line).toBe('myproj•qwen3.8-27b(xhi)•42%/84k•/~/pi/proj(main)');
    expect(line.includes('• ')).toBe(false);
    expect(line.includes(' •')).toBe(false);
  });

  it('renders (branch) glued to the path with no space before the paren', () => {
    const line = strip(render({ level: 'xhigh' })[0]);
    expect(line.includes('proj(main)')).toBe(true);
    expect(line.includes(' proj')).toBe(false);
  });
});

describe('footer v2 status line', () => {
  it('returns exactly 1 line with 0 statuses', () => {
    const lines = render({ level: 'xhigh' });
    expect(lines).toHaveLength(1);
  });

  it('returns exactly 2 lines with 2 statuses', () => {
    const lines = render({
      level: 'xhigh',
      _statuses: new Map([
        ['a', 'x'],
        ['b', 'y'],
      ]),
    } as any);
    expect(lines).toHaveLength(2);
  });

  it('sorts statuses by key and flattens newlines/tabs to spaces', () => {
    const statuses = new Map([
      ['beta', 'second'],
      ['alpha', 'one\n two\t\tthree'],
    ]);
    const lines = render({ level: 'xhigh', _statuses: statuses } as any);
    expect(strip(lines[1])).toBe('one two three second');
  });
});

describe('footer v2 truncation', () => {
  it('keeps the left block intact while shortening the path at width 40', () => {
    const leftBlock = 'myproj•qwen3.8-27b(xhi)•42%/84k';
    const line = strip(render({ level: 'xhigh', name: 'myproj' }, 40)[0]);
    expect(line.startsWith(leftBlock)).toBe(true);
    // Path/branch were shortened (branch collapsed to (...))
    expect(line.includes('...')).toBe(true);
    expect(line.includes('proj(main)')).toBe(false);
  });
});

describe('footer v2 branch coverage (usage, no-branch, dispose)', () => {
  /** Render with a fully custom ctx/footerData (bypasses makeCtx defaults). */
  function renderCustom(
    ctxOverrides: Record<string, unknown>,
    footerDataOverrides: Record<string, unknown> = {},
    width = 100,
    theme?: any,
  ) {
    process.env.HOME = '/home/u';
    const t = theme ?? { fg: (_c: string, s: string) => s };
    const footerData = {
      getGitBranch: () => 'main',
      onBranchChange: () => () => {},
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
      ...footerDataOverrides,
    };
    const ctx: any = {
      model: { name: 'qwen3.8-27b', reasoning: true },
      sessionManager: {
        getCwd: () => '/home/u/pi/proj',
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ tokens: 84000, percent: 42, contextWindow: 200000 }),
      ...ctxOverrides,
    };
    const tui = { requestRender: vi.fn() };
    const comp: any = FooterFactory(tui, t, footerData, ctx, () => 'xhigh');
    return comp.render(width);
  }

  it('renders the no-branch layout (no parens) when getGitBranch is null', () => {
    const lines = renderCustom({}, { getGitBranch: () => null });
    const line = strip(lines[0]);
    expect(line).not.toContain('proj(');
    expect(line.endsWith('proj')).toBe(true);
  });

  it('omits the context segment when usage is unknown (undefined)', () => {
    const lines = renderCustom({ getContextUsage: () => undefined });
    const line = strip(lines[0]);
    expect(line).not.toContain('/84k');
    expect(line).toMatch(/qwen3\.8-27b\(xhi\)•/);
  });

  it('renders ?/windowk when tokens and percent are null', () => {
    const line = strip(
      render({
        level: 'xhigh',
        usage: { tokens: null, percent: null, contextWindow: 200000 },
      })[0],
    );
    expect(line).toContain('?/200k');
  });

  it('renders the raw window size when it is under 1000', () => {
    const line = strip(
      render({
        level: 'xhigh',
        usage: { tokens: null, percent: null, contextWindow: 840 },
      })[0],
    );
    expect(line).toContain('?/840');
  });

  it('color-codes context 50–80% as warning and ≥81% as error', () => {
    const colored = (pct: number) =>
      render(
        { level: 'xhigh', usage: { tokens: 84000, percent: pct, contextWindow: 200000 } },
        100,
        { fg: (c: string, s: string) => `[${c}]${s}` },
      )[0];
    expect(colored(60)).toContain('[warning]60%');
    expect(colored(90)).toContain('[error]90%');
    expect(colored(42)).toContain('[text]42%');
  });

  it('renders no-model when ctx.model is undefined', () => {
    const line = strip(renderCustom({ model: undefined })[0]);
    expect(line.startsWith('no-model')).toBe(true);
  });

  it('renders a single-segment cwd when the cwd is exactly HOME', () => {
    const line = strip(
      renderCustom({
        sessionManager: { getCwd: () => '/home/u', getSessionName: () => undefined },
      })[0],
    );
    expect(line).toBe('qwen3.8-27b(xhi)•42%/84k•~(main)');
  });

  it('dispose() calls the branch unsubscribe once and is safe to call twice', () => {
    let disposed = 0;
    const t = { fg: (_c: string, s: string) => s };
    const footerData = {
      getGitBranch: () => 'main',
      onBranchChange: () => () => {
        disposed++;
      },
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    };
    const ctx: any = {
      model: { name: 'm', reasoning: true },
      sessionManager: { getCwd: () => '/home/u/pi/proj', getSessionName: () => undefined },
      getContextUsage: () => undefined,
    };
    const comp: any = FooterFactory({ requestRender: vi.fn() }, t, footerData, ctx, () => 'low');
    comp.dispose();
    expect(disposed).toBe(1);
    comp.dispose(); // null branch — no throw
    expect(disposed).toBe(1);
  });
});
