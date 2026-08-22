import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock @earendil-works/pi-coding-agent (settings-io now calls getAgentDir() at
// module load to build SETTINGS_PATH; the command module itself uses types only).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => join(process.env.HOME ?? '', '.pi', 'agent'),
}));

// settings-io computes SETTINGS_PATH at module load, so stub HOME BEFORE the
// dynamic import of the command module.
const tmpHome = mkdtempDir();
function mkdtempDir() {
  const dir = join(tmpdir(), `henyo-footer-test-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
  return dir;
}
vi.stubEnv('HOME', tmpHome);

const settingsFile = join(tmpHome, '.pi', 'agent', 'settings.json');
const SETTINGS_SEED = {
  other: { keep: true },
  henyo: { footer: true, toolRepair: false, skills: {} },
};

function writeSettings(obj: unknown) {
  writeFileSync(settingsFile, JSON.stringify(obj, null, 2), 'utf-8');
}
function readSettings(): any {
  return JSON.parse(readFileSync(settingsFile, 'utf-8'));
}

let henyoFooterCommand: (pi: any, applyFooter: (enabled: boolean) => void) => void;
let registerCommand: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const mod: any = await import('../../src/commands/henyo-footer');
  henyoFooterCommand = mod.default;
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(settingsFile)) rmSync(settingsFile);
  writeSettings(SETTINGS_SEED);
  registerCommand = vi.fn((name: string, opts: { description: string; handler: Function }) => {
    (registerCommand as any).captured = { name, opts };
  });
});

function invoke(applyFooter: (enabled: boolean) => void, ui: { notify: ReturnType<typeof vi.fn> }) {
  henyoFooterCommand({ registerCommand } as any, applyFooter);
  const captured: { name: string; opts: { handler: Function } } = (registerCommand as any).captured;
  expect(captured.name).toBe('henyo_footer');
  return captured.opts.handler('', { ui });
}

describe('/henyo_footer command', () => {
  it('registers with a toggle description', () => {
    henyoFooterCommand({ registerCommand } as any, vi.fn());
    expect(registerCommand).toHaveBeenCalledOnce();
    expect((registerCommand as any).captured.opts.description).toContain('Toggle the henyo footer');
  });

  it('flips henyo.footer to false, persists it, and calls applyFooter(false)', async () => {
    const applyFooter = vi.fn();
    const ui = { notify: vi.fn() };
    await invoke(applyFooter, ui);
    expect(readSettings().henyo.footer).toBe(false);
    expect(applyFooter).toHaveBeenCalledWith(false);
  });

  it('second invocation flips back to true and calls applyFooter(true)', async () => {
    const applyFooter = vi.fn();
    const ui = { notify: vi.fn() };
    await invoke(applyFooter, ui);
    await invoke(applyFooter, ui);
    expect(readSettings().henyo.footer).toBe(true);
    expect(applyFooter).toHaveBeenLastCalledWith(true);
  });

  it("notifies the exact wording with type 'info'", async () => {
    const applyFooter = vi.fn();
    const ui = { notify: vi.fn() };
    await invoke(applyFooter, ui);
    expect(ui.notify).toHaveBeenLastCalledWith('Henyo footer disabled', 'info');
    await invoke(applyFooter, ui);
    expect(ui.notify).toHaveBeenLastCalledWith('Henyo footer enabled', 'info');
  });

  it('preserves other top-level keys and the rest of the henyo block', async () => {
    const applyFooter = vi.fn();
    const ui = { notify: vi.fn() };
    await invoke(applyFooter, ui);
    const s = readSettings();
    expect(s.other.keep).toBe(true);
    expect(s.henyo.toolRepair).toBe(false);
    expect(s.henyo.skills).toEqual({});
    expect(s.henyo.footer).toBe(false);
  });

  it('missing settings file: first toggle writes henyo.footer false without throwing', async () => {
    rmSync(settingsFile);
    const applyFooter = vi.fn();
    const ui = { notify: vi.fn() };
    await expect(invoke(applyFooter, ui)).resolves.toBeUndefined();
    expect(readSettings().henyo.footer).toBe(false);
    expect(applyFooter).toHaveBeenCalledWith(false);
    expect(ui.notify).toHaveBeenCalledWith('Henyo footer disabled', 'info');
  });
});
