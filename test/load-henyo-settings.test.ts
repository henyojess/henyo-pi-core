import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock @earendil-works/pi-coding-agent (settings-io calls getAgentDir() at
// module load to build SETTINGS_PATH; other modules only need getAgentDir too).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => join(tmpHome, '.pi', 'agent'),
}));

// settings-io computes SETTINGS_PATH at module load, so stub HOME BEFORE the
// dynamic import of the extension entry point (mirrors henyo-footer.test.ts).
const tmpHome = mkdtempDir();
function mkdtempDir() {
  const dir = join(tmpdir(), `henyo-settings-test-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
  return dir;
}
vi.stubEnv('HOME', tmpHome);

const settingsFile = join(tmpHome, '.pi', 'agent', 'settings.json');

const FULL_DEFAULTS = {
  editPathFix: true,
  toolRepair: true,
  footer: true,
  agentsMd: true,
  ttftTokps: true,
  trace: false,
  skills: { 'plan-generation': true, notes: true },
  commands: { cwd: true, newp: true },
};
const COMPLETE_BLOCK = {
  editPathFix: true,
  toolRepair: true,
  footer: true,
  agentsMd: true,
  ttftTokps: true,
  trace: false,
  skills: { 'plan-generation': true, notes: true },
  commands: { cwd: true, newp: true },
};

function writeSettings(obj: unknown) {
  writeFileSync(settingsFile, JSON.stringify(obj, null, 2), 'utf-8');
}
function rawSettings(): string {
  return readFileSync(settingsFile, 'utf-8');
}
function readSettings(): any {
  return JSON.parse(rawSettings());
}

let loadHenyoSettings: () => any;

beforeAll(async () => {
  const mod: any = await import('../src/index');
  loadHenyoSettings = mod.loadHenyoSettings;
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(settingsFile)) rmSync(settingsFile);
});

describe('loadHenyoSettings', () => {
  it('missing settings file → full defaults returned AND file created with complete henyo block', () => {
    const s = loadHenyoSettings();
    expect(s).toEqual(FULL_DEFAULTS);
    expect(readSettings().henyo).toEqual(FULL_DEFAULTS);
    // Exact block shape: 8 top-level keys; nested objects carry the 2 skill
    // and 2 command keys (12 known keys total incl. editPathFix).
    expect(Object.keys(readSettings().henyo).sort()).toEqual([
      'agentsMd',
      'commands',
      'editPathFix',
      'footer',
      'skills',
      'toolRepair',
      'trace',
      'ttftTokps',
    ]);
    expect(Object.keys(readSettings().henyo.skills).sort()).toEqual(['notes', 'plan-generation']);
    expect(Object.keys(readSettings().henyo.commands).sort()).toEqual(['cwd', 'newp']);
  });

  it('complete henyo block → file bytes unchanged after load (steady state, zero writes)', () => {
    writeSettings({ other: { keep: true }, henyo: { ...COMPLETE_BLOCK } });
    const before = rawSettings();
    const s = loadHenyoSettings();
    expect(s).toEqual(FULL_DEFAULTS);
    expect(rawSettings()).toBe(before);
    expect(readSettings().other.keep).toBe(true);
  });

  it('complete block with non-default values → file bytes unchanged (values are not a write trigger)', () => {
    const block = { ...COMPLETE_BLOCK, footer: false, skills: { ...COMPLETE_BLOCK.skills, notes: false } };
    writeSettings({ henyo: block });
    const before = rawSettings();
    const s = loadHenyoSettings();
    expect(s.footer).toBe(false);
    expect(s.skills.notes).toBe(false);
    expect(rawSettings()).toBe(before);
  });

  it('missing top-level keys → merged defaults returned; file gained only the missing keys; existing values untouched', () => {
    writeSettings({
      other: { keep: true },
      henyo: { footer: false, skills: { ...COMPLETE_BLOCK.skills }, commands: { ...COMPLETE_BLOCK.commands } },
    });
    const s = loadHenyoSettings();
    expect(s.footer).toBe(false); // preserved
    expect(s.toolRepair).toBe(true); // filled
    expect(s.agentsMd).toBe(true); // filled
    const onDisk = readSettings();
    expect(onDisk.henyo.footer).toBe(false); // existing value untouched
    expect(onDisk.henyo.toolRepair).toBe(true); // filled in file
    expect(onDisk.henyo.agentsMd).toBe(true); // filled in file
    expect(onDisk.other.keep).toBe(true); // other top-level keys preserved
    expect(onDisk.henyo.editPathFix).toBe(true); // filled (resolved from toolRepair default)
  });

  it('partial nested skills block → user value kept, missing sibling filled (naive-spread hazard)', () => {
    writeSettings({
      henyo: {
        ...COMPLETE_BLOCK,
        skills: { notes: false },
      },
    });
    const s = loadHenyoSettings();
    expect(s.skills.notes).toBe(false);
    expect(s.skills['plan-generation']).toBe(true);
    const onDisk = readSettings();
    expect(onDisk.henyo.skills.notes).toBe(false);
    expect(onDisk.henyo.skills['plan-generation']).toBe(true);
  });

  it('henyo.skills is an array → skills defaults in result, no throw', () => {
    writeSettings({
      henyo: {
        ...COMPLETE_BLOCK,
        skills: [1, 2],
      },
    });
    const s = loadHenyoSettings();
    expect(s.skills).toEqual(COMPLETE_BLOCK.skills);
    expect(readSettings().henyo.skills).toEqual(COMPLETE_BLOCK.skills);
  });

  it('invalid JSON settings file → all defaults returned, no throw', () => {
    writeFileSync(settingsFile, 'not json {', 'utf-8');
    expect(() => loadHenyoSettings()).not.toThrow();
    const s = loadHenyoSettings();
    expect(s).toEqual(FULL_DEFAULTS);
    // Reader tolerates invalid JSON → {} → fill write replaces the file with
    // { henyo: defaults }.
    expect(readSettings()).toEqual({ henyo: FULL_DEFAULTS });
  });

  it('legacy block { toolRepair: false } only → editPathFix: false in result AND file (migration write, behavior preserved)', () => {
    writeSettings({ other: { keep: true }, henyo: { toolRepair: false } });
    const s = loadHenyoSettings();
    expect(s.editPathFix).toBe(false); // resolved from legacy toolRepair
    expect(s.toolRepair).toBe(false);
    expect(s.footer).toBe(true); // filled
    const onDisk = readSettings();
    expect(onDisk.henyo.editPathFix).toBe(false); // migration write: resolved value persisted
    expect(onDisk.other.keep).toBe(true);
  });

  it('block lacking ttftTokps/trace → both filled with defaults in result AND persisted by the fill write', () => {
    writeSettings({
      other: { keep: true },
      henyo: {
        editPathFix: true,
        toolRepair: true,
        footer: true,
        agentsMd: true,
        skills: { 'plan-generation': true, notes: true },
        commands: { cwd: true, newp: true },
      },
    });
    const s = loadHenyoSettings();
    expect(s.ttftTokps).toBe(true); // filled
    expect(s.trace).toBe(false); // filled
    const onDisk = readSettings();
    expect(onDisk.henyo.ttftTokps).toBe(true); // filled in file
    expect(onDisk.henyo.trace).toBe(false); // filled in file
    expect(onDisk.other.keep).toBe(true); // other keys preserved
  });

  it('editPathFix: false passes through unchanged and survives the fill write', () => {
    writeSettings({
      henyo: {
        editPathFix: false,
        toolRepair: true,
        footer: true,
        agentsMd: true,
        skills: { 'plan-generation': true },
        commands: { ...COMPLETE_BLOCK.commands },
      },
    });
    const s = loadHenyoSettings();
    expect(s.editPathFix).toBe(false);
    expect(s.skills.notes).toBe(true); // filled
    const onDisk = readSettings();
    expect(onDisk.henyo.editPathFix).toBe(false); // preserved through fill write
    expect(onDisk.henyo.skills.notes).toBe(true);
  });
});
