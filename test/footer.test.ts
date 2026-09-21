import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @earendil-works/pi-coding-agent (types only are used by footer.ts,
// but the pattern matches the rest of the suite)
vi.mock('@earendil-works/pi-coding-agent', () => ({}));

import { FooterFactory } from '../src/footer.js';

// ANSI escape sequences (ESC [ ... m) — the control char is intentional.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, '');

interface CtxOpts {
  name?: string | undefined;
  model?: string;
  reasoning?: boolean;
  level: string;
  usage?: { tokens: number | null; percent: number | null; contextWindow: number };
}

function makeCtx(opts: CtxOpts): any {
  return {
    model: {
      name: opts.model ?? 'qwen3.8-27b',
      reasoning: opts.reasoning ?? true,
      compat: { supportsReasoningEffort: opts.reasoning ?? true },
    },
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
  const tui = { requestRender: vi.fn() } as any;
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

  it('appends (off) for level off on a reasoning model', () => {
    const line = strip(render({ level: 'off' })[0]);
    expect(line.startsWith('qwen3.8-27b(off)')).toBe(true);
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
      model: {
        name: 'qwen3.8-27b',
        reasoning: true,
        compat: { supportsReasoningEffort: true },
      },
      sessionManager: {
        getCwd: () => '/home/u/pi/proj',
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ tokens: 84000, percent: 42, contextWindow: 200000 }),
      ...ctxOverrides,
    };
    const tui = { requestRender: vi.fn() } as any;
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

  it('shows (off) for reasoning models without level support at off', () => {
    const t = { fg: (_c: string, s: string) => s } as any;
    const footerData = {
      getGitBranch: () => 'main',
      onBranchChange: () => () => {},
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    };
    const ctx: any = {
      model: {
        name: 'qwen3.6-35b-a3b',
        reasoning: true,
        compat: { supportsReasoningEffort: false },
      },
      sessionManager: { getCwd: () => '/home/u/pi/proj', getSessionName: () => undefined },
      getContextUsage: () => ({ tokens: 84000, percent: 42, contextWindow: 200000 }),
    };
    const comp: any = FooterFactory(
      { requestRender: vi.fn() } as any,
      t,
      footerData,
      ctx,
      () => 'off',
    );
    const line = strip(comp.render(100)[0]);
    expect(line).toContain('qwen3.6-35b-a3b(off)');
  });

  it('shows (on) for reasoning models without level support at non-off', () => {
    const t = { fg: (_c: string, s: string) => s } as any;
    const footerData = {
      getGitBranch: () => 'main',
      onBranchChange: () => () => {},
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    };
    const ctx: any = {
      model: {
        name: 'qwen3.6-35b-a3b',
        reasoning: true,
        compat: { supportsReasoningEffort: false },
      },
      sessionManager: { getCwd: () => '/home/u/pi/proj', getSessionName: () => undefined },
      getContextUsage: () => ({ tokens: 84000, percent: 42, contextWindow: 200000 }),
    };
    const comp: any = FooterFactory(
      { requestRender: vi.fn() } as any,
      t,
      footerData,
      ctx,
      () => 'high',
    );
    const line = strip(comp.render(100)[0]);
    expect(line).toContain('qwen3.6-35b-a3b(on)');
  });

  it('dispose() calls the branch unsubscribe once and is safe to call twice', () => {
    let disposed = 0;
    const t = { fg: (_c: string, s: string) => s } as any;
    const footerData = {
      getGitBranch: () => 'main',
      onBranchChange: () => () => {
        disposed++;
      },
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    };
    const ctx: any = {
      model: { name: 'm', reasoning: true, compat: { supportsReasoningEffort: true } },
      sessionManager: { getCwd: () => '/home/u/pi/proj', getSessionName: () => undefined },
      getContextUsage: () => undefined,
    };
    const comp: any = FooterFactory(
      { requestRender: vi.fn() } as any,
      t,
      footerData,
      ctx,
      () => 'low',
    );
    comp.dispose();
    expect(disposed).toBe(1);
    comp.dispose(); // null branch — no throw
    expect(disposed).toBe(1);
  });
});

describe('footer v2 focus, no-theme, and edge paths', () => {
  /** Build a component, capturing the branch-change callback and TUI spy. */
  function build(
    opts: {
      theme?: any;
      width?: number;
      branch?: string | null;
      statuses?: Map<string, string>;
    } = {},
  ) {
    process.env.HOME = '/home/u';
    let branchCb: (() => void) | null = null;
    const tui = { requestRender: vi.fn() } as any;
    const defaultTheme = { fg: (_c: string, s: string) => s };
    const footerData = {
      getGitBranch: () => (opts.branch === undefined ? 'main' : opts.branch),
      onBranchChange: (cb: () => void) => {
        branchCb = cb;
        return () => {};
      },
      getExtensionStatuses: () => opts.statuses ?? new Map(),
      getAvailableProviderCount: () => 1,
    };
    const ctx: any = {
      model: { name: 'qwen3.8-27b', reasoning: true, compat: { supportsReasoningEffort: true } },
      sessionManager: { getCwd: () => '/home/u/pi/proj', getSessionName: () => undefined },
      getContextUsage: () => ({ tokens: 84000, percent: 42, contextWindow: 200000 }),
    };
    const comp: any = FooterFactory(
      tui,
      opts.theme === undefined ? defaultTheme : opts.theme,
      footerData,
      ctx,
      () => 'xhigh',
    );
    return { comp, tui, branchCb };
  }

  it('focused getter returns the initial value and the setter round-trips', () => {
    const { comp } = build({});
    expect(comp.focused).toBe(false); // initial value
    comp.focused = true;
    expect(comp.focused).toBe(true);
    comp.focused = false;
    expect(comp.focused).toBe(false);
  });

  it('buildLine returns "" when no theme has been initialized', () => {
    // Factory called with a null theme: init(null) leaves _theme unset.
    // render() guards buildLine, so call buildLine directly to observe the
    // no-theme early return.
    const { comp } = build({ theme: null });
    expect(comp.buildLine(100)).toBe('');
    // and render() emits zero footer lines in this state
    expect(comp.render(100)).toHaveLength(0);
  });

  it('status line is null-equivalent when a theme is absent, even with registered statuses', () => {
    const statuses = new Map([['ext', 'busy']]);
    const { comp } = build({ theme: null, statuses });
    // buildStatusLine early-returns on missing theme → single line stays absent
    expect(comp.buildStatusLine(100)).toBeNull();
    expect(comp.render(100)).toHaveLength(0);
  });

  it('no-branch layout: grow-left loop breaks on first iteration at very narrow width', () => {
    // Left block 'qwen3.8-27b(xhi)•42%/84k' = 25 chars; width 25 leaves 0 for cwd.
    // Last segment 'proj' (4 chars) overflows → break on the first iteration,
    // output ends with the truncated/last segment 'proj'.
    const { comp } = build({ branch: null, theme: { fg: (_c: string, s: string) => s } });
    const line = strip(comp.render(25)[0]);
    expect(line).toBe('qwen3.8-27b(xhi)•42%/84k•proj');
  });

  it('branch present: ellipsis truncation (maxBranch > 0) keeps parens with ...)', () => {
    // Branch 'feature/repo/long-name' → 24 chars with parens. At width 52 the
    // grow-left loop breaks on the first iteration (4+1+24 > 27), cwd='proj' (4),
    // available = 52 - 25 - 1 - 4 = 22 < 24 → maxBranch = 17 > 0 → '(<17>...)'
    const { comp } = build({
      branch: 'feature/repo/long-name',
      theme: { fg: (_c: string, s: string) => s },
    });
    const line = strip(comp.render(52)[0]);
    expect(line.endsWith('...)')).toBe(true);
    expect(line).toContain('proj(');
    expect(line).not.toContain('(feature/repo/long-name)');
    // deterministic: same input → same output
    expect(strip(comp.render(52)[0])).toBe(line);
  });

  it('branch present: collapses to (...) when available - 5 <= 0', () => {
    // width 34 → available = 34 - 25 - 1 - 4 = 4 → maxBranch = -1 → '(...)'
    const { comp } = build({
      branch: 'feature/repo/long-name',
      theme: { fg: (_c: string, s: string) => s },
    });
    const line = strip(comp.render(34)[0]);
    expect(line.endsWith('proj(...)')).toBe(true);
  });

  it('branch-change event triggers requestRender exactly once', () => {
    const { tui, branchCb } = build({});
    const cb = branchCb as (() => void) | null;
    expect(typeof cb).toBe('function');
    if (cb) cb();
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });
});
