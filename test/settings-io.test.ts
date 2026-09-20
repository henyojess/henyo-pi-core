import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock @earendil-works/pi-coding-agent (settings-io calls getAgentDir() at
// module load to build SETTINGS_PATH).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => join(tmpHome, '.pi', 'agent'),
}));

// settings-io computes SETTINGS_PATH at module load, so stub HOME BEFORE the
// dynamic import of the module under test.
const tmpHome = mkdtempDir();
function mkdtempDir() {
  const dir = join(tmpdir(), `settings-io-test-${Math.random().toString(36).slice(2, 10)}`);
  fs.mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
  return dir;
}
vi.stubEnv('HOME', tmpHome);

const agentDir = join(tmpHome, '.pi', 'agent');

/** Settings entries a crashed/interrupted write could have left behind. */
const tmpEntries = (): string[] =>
  fs.readdirSync(agentDir).filter((f) => f.startsWith('settings.json.tmp-'));

let writeSettingsFile: (data: Record<string, any>) => void;
let SETTINGS_PATH: string;

beforeAll(async () => {
  const mod: any = await import('../src/settings-io.js');
  writeSettingsFile = mod.writeSettingsFile;
  SETTINGS_PATH = mod.SETTINGS_PATH;
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  if (fs.existsSync(SETTINGS_PATH)) fs.rmSync(SETTINGS_PATH);
  for (const f of tmpEntries()) fs.rmSync(join(agentDir, f));
});

describe('writeSettingsFile (atomic tmp + rename)', () => {
  it('writes the exact JSON to SETTINGS_PATH and leaves no tmp file behind', () => {
    writeSettingsFile({ a: 1 });
    expect(fs.readFileSync(SETTINGS_PATH, 'utf-8')).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(tmpEntries()).toHaveLength(0);
  });

  it('rename failure leaves the pre-existing file byte-for-byte unchanged', () => {
    fs.writeFileSync(SETTINGS_PATH, '{"keep":true}', 'utf-8');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      writeSettingsFile({ other: 1 });
      // silent-fail: no throw out of writeSettingsFile
      expect(fs.readFileSync(SETTINGS_PATH, 'utf-8')).toBe('{"keep":true}');
      // best-effort tmp cleanup ran
      expect(tmpEntries()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('whole-file rewrite preserves the silent-fail contract for valid data', () => {
    fs.writeFileSync(SETTINGS_PATH, '{"old":true}', 'utf-8');
    writeSettingsFile({ b: 2 });
    expect(JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))).toEqual({ b: 2 });
  });
});
