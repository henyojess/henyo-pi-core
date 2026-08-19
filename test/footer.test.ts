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
