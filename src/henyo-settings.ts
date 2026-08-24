import { readSettingsFile } from './settings-io.js';

/** The `henyo` block of ~/.pi/agent/settings.json (always fully merged). */
export interface HenyoSettings {
  /** Standalone edit path fix + coaching + prompt guideline. */
  editPathFix: boolean;
  /** Legacy key — honored when `editPathFix` is unset. */
  toolRepair: boolean;
  footer: boolean;
  agentsMd: boolean;
  skills: Record<string, boolean>;
  commands: Record<string, boolean>;
}

export const DEFAULTS: HenyoSettings = {
  editPathFix: true,
  toolRepair: true,
  footer: true,
  agentsMd: true,
  skills: { 'plan-generation': true, notes: true },
  commands: { cwd: true, newp: true },
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge the on-disk `henyo` block over DEFAULTS (nested `skills`/`commands`
 * merged key-by-key so a partial user block never hides default siblings).
 * Returns a fresh copy of the merged settings (module-level DEFAULTS is
 * never exposed or mutated) and whether the input was missing any of the
 * 10 known keys (`editPathFix`, `toolRepair`, `footer`, `agentsMd`,
 * skills×2, commands×2) — values are never a write trigger.
 */
export function mergeHenyo(user: unknown): { henyo: HenyoSettings; changed: boolean } {
  const henyo: HenyoSettings = { ...DEFAULTS };
  if (!isPlainObject(user)) {
    henyo.skills = { ...DEFAULTS.skills };
    henyo.commands = { ...DEFAULTS.commands };
    return { henyo, changed: true };
  }
  const h = user as Partial<HenyoSettings>;
  henyo.editPathFix = h.editPathFix ?? h.toolRepair ?? DEFAULTS.toolRepair;
  henyo.toolRepair = h.toolRepair ?? DEFAULTS.toolRepair;
  henyo.footer = h.footer ?? DEFAULTS.footer;
  henyo.agentsMd = h.agentsMd ?? DEFAULTS.agentsMd;
  const userSkills = isPlainObject(h.skills) ? h.skills : {};
  const userCommands = isPlainObject(h.commands) ? h.commands : {};
  henyo.skills = { ...DEFAULTS.skills, ...userSkills };
  henyo.commands = { ...DEFAULTS.commands, ...userCommands };
  const knownKeys: (keyof HenyoSettings)[] = [
    'editPathFix',
    'toolRepair',
    'footer',
    'agentsMd',
    'skills',
    'commands',
  ];
  const changed =
    knownKeys.some((key) => !(key in h)) ||
    Object.keys(DEFAULTS.skills).some((key) => !(key in userSkills)) ||
    Object.keys(DEFAULTS.commands).some((key) => !(key in userCommands));
  return { henyo, changed };
}

/**
 * Effective henyo settings (merged with defaults, user values preferred).
 * Read-only: never writes the settings file (use loadHenyoSettings from
 * index.ts for the fill-on-first-load behavior).
 */
export function getEffectiveHenyoSettings(): HenyoSettings {
  return mergeHenyo(readSettingsFile().henyo).henyo;
}
