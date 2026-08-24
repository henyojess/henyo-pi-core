import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock @earendil-works/pi-coding-agent (settings-io / edit-path-repair call
// getAgentDir(); the command module itself uses types only).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => join(process.env.HOME ?? '', '.pi', 'agent'),
}));

// settings-io computes SETTINGS_PATH at module load, so stub HOME BEFORE the
// dynamic import of the command module (same pattern as cwd.test.ts).
const tmpHome = mkdtempDir();
function mkdtempDir() {
  const dir = join(tmpdir(), `henyo-cmd-test-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
  return dir;
}
vi.stubEnv('HOME', tmpHome);

const settingsFile = join(tmpHome, '.pi', 'agent', 'settings.json');
const SEED = {
  other: { keep: true },
  henyo: {
    editPathFix: true,
    toolRepair: true,
    footer: true,
    agentsMd: true,
    skills: { 'plan-generation': true, notes: true },
    commands: { cwd: true, newp: true },
  },
};
const CANONICAL_KEYS = [
  'editPathFix',
  'footer',
  'agentsMd',
  'skills.plan-generation',
  'skills.notes',
  'commands.cwd',
  'commands.newp',
];

function writeSettings(obj: unknown) {
  writeFileSync(settingsFile, JSON.stringify(obj, null, 2), 'utf-8');
}
function readSettings(): any {
  return JSON.parse(readFileSync(settingsFile, 'utf-8'));
}

let henyoCommand: (pi: any, applyFooter: (enabled: boolean) => void) => void;
let captured: { name: string; opts: { description: string; getArgumentCompletions: Function; handler: Function } } | null =
  null;

beforeAll(async () => {
  const mod: any = await import('../../src/commands/henyo');
  henyoCommand = mod.default;
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  captured = null;
  if (existsSync(settingsFile)) rmSync(settingsFile);
  writeSettings(SEED);
});

/** Register the command and return the captured options. */
function register(applyFooter: (enabled: boolean) => void = vi.fn()) {
  henyoCommand(
    { registerCommand: (name: string, opts: any) => (captured = { name, opts }) },
    applyFooter,
  );
  return { applyFooter, opts: captured!.opts };
}

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    hasUI: true,
    ui: { notify: vi.fn(), select: vi.fn(async () => undefined) },
    reload: vi.fn(async () => {}),
    ...overrides,
  };
}

async function invoke(opts: any, args: string, ctxOverrides: Record<string, any> = {}) {
  const ctx = makeCtx(ctxOverrides);
  await opts.handler(args, ctx);
  return ctx;
}

describe('/henyo command', () => {
  // ── registration & completions ──────────────────────────────────────
  it('registers name "henyo" with description and getArgumentCompletions', () => {
    register();
    expect(captured!.name).toBe('henyo');
    expect(captured!.opts.description).toContain('List or toggle henyo features');
    expect(captured!.opts.getArgumentCompletions).toBeTypeOf('function');
  });

  it('completions token 1: empty prefix → all 7 canonical keys', () => {
    const { opts } = register();
    const items = opts.getArgumentCompletions('');
    expect(items.map((i: any) => i.value)).toEqual(CANONICAL_KEYS);
    for (const i of items) expect(i.label).toBe(i.value);
  });

  it('completions token 1: "com" → the 2 commands.* keys', () => {
    const { opts } = register();
    const items = opts.getArgumentCompletions('com');
    expect(items.map((i: any) => i.value)).toEqual(['commands.cwd', 'commands.newp']);
  });

  it('completions token 1: shorthand prefix "no" → skills.notes (value stays canonical)', () => {
    const { opts } = register();
    const items = opts.getArgumentCompletions('no');
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe('skills.notes');
  });

  it('completions token 2: "footer o" → values as full arguments, labels bare', () => {
    const { opts } = register();
    const items = opts.getArgumentCompletions('footer o');
    expect(items).toEqual([
      { value: 'footer on', label: 'on' },
      { value: 'footer off', label: 'off' },
    ]);
  });

  it('completions token 2: unmatched first token "zzz o" → null', () => {
    const { opts } = register();
    expect(opts.getArgumentCompletions('zzz o')).toBeNull();
  });

  // ── bare /henyo (picker) ────────────────────────────────────────────
  it('bare args (TUI): ui.select called with 7 labels matching seeded states', async () => {
    writeSettings({ henyo: { ...SEED.henyo, footer: false } });
    const { opts } = register();
    const ctx = await invoke(opts, '');
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    const [title, labels] = ctx.ui.select.mock.calls[0];
    expect(title).toBe('Henyo features (pick to toggle):');
    expect(labels).toEqual([
      'editPathFix: on',
      'footer: off',
      'agentsMd: on',
      'skills.plan-generation: on',
      'skills.notes: on',
      'commands.cwd: on',
      'commands.newp: on',
    ]);
  });

  it('select a non-footer key → disk updated, reload called, "— reloading" toast', async () => {
    const { opts, applyFooter } = register();
    const ctx = makeCtx({ ui: { notify: vi.fn(), select: vi.fn(async () => 'agentsMd: on') } });
    await opts.handler('', ctx);
    expect(readSettings().henyo.agentsMd).toBe(false); // was true → flipped off
    expect(ctx.reload).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Henyo agentsMd disabled — reloading', 'info');
    expect(applyFooter).not.toHaveBeenCalled();
  });

  it('select "footer" → applyFooter called, NO reload, no reloading hint', async () => {
    const { opts, applyFooter } = register();
    const ctx = makeCtx({ ui: { notify: vi.fn(), select: vi.fn(async () => 'footer: on') } });
    await opts.handler('', ctx);
    expect(readSettings().henyo.footer).toBe(false);
    expect(applyFooter).toHaveBeenCalledWith(false);
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Henyo footer disabled', 'info');
    expect(String(ctx.ui.notify.mock.calls[0][0])).not.toContain('reloading');
  });

  it('select dismissed (undefined) → no settings write', async () => {
    const before = readFileSync(settingsFile, 'utf-8');
    const { opts } = register();
    const ctx = await invoke(opts, ''); // select default → undefined
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    expect(readFileSync(settingsFile, 'utf-8')).toBe(before);
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  // ── explicit args ───────────────────────────────────────────────────
  it('/henyo footer off → disk false, applyFooter(false), no reload', async () => {
    const { opts, applyFooter } = register();
    const ctx = await invoke(opts, 'footer off');
    expect(readSettings().henyo.footer).toBe(false);
    expect(applyFooter).toHaveBeenCalledWith(false);
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Henyo footer disabled', 'info');
  });

  it('/henyo agentsMd on → disk true, reload called, exact toast', async () => {
    const { opts } = register();
    const ctx = await invoke(opts, 'agentsMd on');
    expect(readSettings().henyo.agentsMd).toBe(true);
    expect(ctx.reload).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Henyo agentsMd enabled — reloading', 'info');
  });

  it('/henyo skills.notes off → nested key written, sibling preserved', async () => {
    const { opts } = register();
    const ctx = await invoke(opts, 'skills.notes off');
    expect(readSettings().henyo.skills.notes).toBe(false);
    expect(readSettings().henyo.skills['plan-generation']).toBe(true);
    expect(ctx.reload).toHaveBeenCalledOnce();
  });

  it('shorthand: /henyo notes off → disk skills.notes false', async () => {
    const { opts } = register();
    await invoke(opts, 'notes off');
    expect(readSettings().henyo.skills.notes).toBe(false);
  });

  it('single-arg flip: seeded footer true → /henyo footer → disk false', async () => {
    const { opts, applyFooter } = register();
    const ctx = await invoke(opts, 'footer');
    expect(readSettings().henyo.footer).toBe(false);
    expect(applyFooter).toHaveBeenCalledWith(false);
  });

  it('case-insensitive value: /henyo footer ON → disk true', async () => {
    const { opts, applyFooter } = register();
    await invoke(opts, 'footer ON');
    expect(readSettings().henyo.footer).toBe(true);
    expect(applyFooter).toHaveBeenCalledWith(true);
  });

  it('unknown key → error notify listing valid keys, no write, no reload', async () => {
    const before = readFileSync(settingsFile, 'utf-8');
    const { opts } = register();
    const ctx = await invoke(opts, 'bogus on');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Unknown henyo key "bogus". Valid keys: ' + CANONICAL_KEYS.join(', '),
      'error',
    );
    expect(readFileSync(settingsFile, 'utf-8')).toBe(before);
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it('invalid value → error notify listing the 6 values, no write', async () => {
    const before = readFileSync(settingsFile, 'utf-8');
    const { opts } = register();
    const ctx = await invoke(opts, 'footer maybe');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Invalid value "maybe" — use on, off, true, false, enable or disable',
      'error',
    );
    expect(readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  it('3 tokens → usage error notify', async () => {
    const { opts } = register();
    const ctx = await invoke(opts, 'footer on extra');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Usage: /henyo <key> [on|off|true|false|enable|disable]',
      'error',
    );
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it('non-TUI: bare args silent no-op; explicit toggle writes disk, no notify', async () => {
    const { opts, applyFooter } = register();
    // Bare args: silent no-op (ui has no select in non-TUI mode).
    const ctxBare = await invoke(opts, '', { hasUI: false, ui: { notify: vi.fn() } });
    expect(readSettings().henyo.footer).toBe(true); // untouched
    expect(ctxBare.reload).not.toHaveBeenCalled();
    expect(ctxBare.ui.notify).not.toHaveBeenCalled();
    // Explicit args: write + reload, no notify.
    const ctxExplicit = await invoke(opts, 'agentsMd off', { hasUI: false, ui: { notify: vi.fn() } });
    expect(readSettings().henyo.agentsMd).toBe(false);
    expect(ctxExplicit.reload).toHaveBeenCalledOnce();
    expect(ctxExplicit.ui.notify).not.toHaveBeenCalled();
    expect(applyFooter).not.toHaveBeenCalled();
  });

  it('missing settings file → defaults drive state, toggle writes without throwing', async () => {
    rmSync(settingsFile);
    const { opts } = register();
    const ctx = await invoke(opts, 'agentsMd off');
    expect(ctx).toBeDefined();
    expect(readSettings().henyo.agentsMd).toBe(false);
    expect(ctx.reload).toHaveBeenCalledOnce();
  });

  it('preserves other top-level keys and the rest of the henyo block', async () => {
    writeSettings({ other: { keep: true }, henyo: { footer: true, toolRepair: false, skills: {} } });
    const { opts } = register();
    await invoke(opts, 'footer off');
    const s = readSettings();
    expect(s.other.keep).toBe(true);
    expect(s.henyo.toolRepair).toBe(false);
    expect(s.henyo.skills).toEqual({});
    expect(s.henyo.footer).toBe(false);
  });
});
