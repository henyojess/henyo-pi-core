import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock @earendil-works/pi-coding-agent (settings-io and edit-path-repair call
// getAgentDir(); the extension module itself uses the pi object passed in).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => join(tmpHome, '.pi', 'agent'),
}));

// Temp HOME so the extension writes settings / copies AGENTS.md into a
// disposable dir (pattern shared with load-henyo-settings.test.ts).
const tmpHome = mkdtempDir();
function mkdtempDir() {
  const dir = join(tmpdir(), `henyo-index-test-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
  return dir;
}

const settingsFile = join(tmpHome, '.pi', 'agent', 'settings.json');
const agentsMdDst = join(tmpHome, '.pi', 'agent', 'AGENTS.md');

let mod: typeof import('../src/index');
let readSettingsFile: (p?: never) => Record<string, any>;

function createStubPi() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  return {
    handlers,
    commands,
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand(name: string, opts: any) {
      commands.set(name, opts);
    },
    getThinkingLevel: () => 'high',
  };
}

const stubTheme = { fg: (_style: string, text: string) => text } as any;
const stubFooterData = {
  onBranchChange: () => () => {},
} as any;
const stubTui = { requestRender: vi.fn() } as any;

function makeCtx() {
  let footerCb: any = undefined;
  return {
    ctx: {
      hasUI: true,
      ui: {
        setFooter(cb: any) {
          footerCb = cb;
        },
        notify: vi.fn(),
      },
      model: { name: 'stub-model' },
    },
    getFooterCb: () => footerCb,
  };
}

beforeAll(async () => {
  mod = await import('../src/index');
  ({ readSettingsFile } = await import('../src/settings-io'));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('extension entry point (src/index.ts)', () => {
  it('case A: fills default settings, registers commands, discovers skills', async () => {
    const stub = createStubPi();
    await mod.default(stub);

    // Fill-write: no settings file existed → full henyo block written.
    expect(existsSync(settingsFile)).toBe(true);
    const written = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    expect(written.henyo.footer).toBe(true);
    expect(written.henyo.toolRepair).toBe(true);
    expect(written.henyo.skills).toEqual({ 'plan-generation': true, notes: true });
    expect(written.henyo.commands).toEqual({ cwd: true, newp: true });

    // All commands registered (defaults = enabled).
    for (const name of ['cwd', 'newp']) {
      expect(stub.commands.has(name)).toBe(true);
    }

    // resources_discover returns the enabled skill paths and they exist.
    const discover = stub.handlers.get('resources_discover');
    expect(discover).toBeTypeOf('function');
    const result = await discover({}, {});
    expect(result.skillPaths).toHaveLength(2);
    for (const p of result.skillPaths) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it('case B: session_start copies AGENTS.md, attaches footer, model_select re-renders', async () => {
    const stub = createStubPi();
    await mod.default(stub);
    const { ctx, getFooterCb } = makeCtx();

    await stub.handlers.get('session_start')({}, ctx);

    // Lazy init: SAMPLE_GLOBAL_AGENTS.md copied into the agent dir.
    expect(existsSync(agentsMdDst)).toBe(true);

    // footer !== false → setFooter received a live factory.
    expect(getFooterCb()).toBeTypeOf('function');
    getFooterCb()(stubTui, stubTheme, stubFooterData, ctx);

    // footerTui is captured inside the footer callback → model_select re-renders.
    stub.handlers.get('model_select')();
    expect(stubTui.requestRender).toHaveBeenCalled();
  });

  it('case C: henyo.footer=false → session_start clears the footer', async () => {
    writeFileSync(settingsFile, JSON.stringify({ henyo: { footer: false } }), 'utf-8');
    const stub = createStubPi();
    await mod.default(stub);
    const { ctx, getFooterCb } = makeCtx();

    await stub.handlers.get('session_start')({}, ctx);

    expect(getFooterCb()).toBeUndefined();
  });

  it('case E: all commands.* false → /henyo still registered (unconditional), gated commands omitted', async () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        henyo: {
          editPathFix: true,
          toolRepair: true,
          footer: true,
          agentsMd: true,
          skills: { 'plan-generation': true, notes: true },
          commands: { cwd: false, newp: false },
        },
      }),
      'utf-8',
    );
    const stub = createStubPi();
    await mod.default(stub);

    expect(stub.commands.has('henyo')).toBe(true);
    expect(stub.commands.has('cwd')).toBe(false);
    expect(stub.commands.has('newp')).toBe(false);
  });

  it('case D: settings.json with non-object JSON → readSettingsFile returns {}', () => {
    writeFileSync(settingsFile, '[1,2]', 'utf-8');
    expect(readSettingsFile()).toEqual({});
  });
});
