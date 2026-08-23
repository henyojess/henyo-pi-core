import { editPathRepairExtension, resolveEditPathFix } from './edit-path-repair.js';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI as _ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import cwdCommand from './commands/cwd.js';
import newpCommand from './commands/newp.js';
import henyoFooterCommand from './commands/henyo-footer.js';
import { FooterFactory } from './footer.js';
import { readSettingsFile, writeSettingsFile } from './settings-io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve a path relative to this extension's installed location. */
function extPath(...segments: string[]) {
  return join(__dirname, '..', ...segments);
}

// ─── Henyo Settings Block ──────────────────────────────────────────────

interface HenyoSettings {
  /** Standalone edit path fix + coaching + prompt guideline. */
  editPathFix: boolean;
  /** Legacy key — honored when `editPathFix` is unset. */
  toolRepair: boolean;
  footer: boolean;
  agentsMd: boolean;
  skills: Record<string, boolean>;
  commands: Record<string, boolean>;
}

const DEFAULTS: HenyoSettings = {
  editPathFix: true,
  toolRepair: true,
  footer: true,
  agentsMd: true,
  skills: { 'plan-generation': true, notes: true },
  commands: { cwd: true, newp: true, henyo_footer: true },
};
const SKILLS = { 'plan-generation': 'skills/plan-generation', notes: 'skills/notes' };
function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge the on-disk `henyo` block over DEFAULTS (nested `skills`/`commands`
 * merged key-by-key so a partial user block never hides default siblings).
 * Returns a fresh copy of the merged settings (module-level DEFAULTS is
 * never exposed or mutated) and whether the input was missing any of the
 * 11 known keys (`editPathFix`, `toolRepair`, `footer`, `agentsMd`,
 * skills×2, commands×3) — values are never a write trigger.
 */
function mergeHenyo(user: unknown): { henyo: HenyoSettings; changed: boolean } {
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

const COMMANDS: Record<
  string,
  (pi: _ExtensionAPI, applyFooter: (enabled: boolean) => void) => void
> = {
  cwd: cwdCommand,
  newp: newpCommand,
  henyo_footer: henyoFooterCommand,
};

/**
 * Load henyo settings from ~/.pi/agent/settings.json. Never throws.
 * Returns the merged settings in memory (all defaults filled in, user
 * values preferred). When the on-disk `henyo` block is missing keys —
 * first install, or an upgrade that added features — a single write adds
 * the missing keys with their defaults; existing keys and values are never
 * modified (steady state = zero writes).
 */
export function loadHenyoSettings(): HenyoSettings {
  try {
    const settings = readSettingsFile();
    const { henyo, changed } = mergeHenyo(settings.henyo);
    if (changed) {
      writeSettingsFile({ ...settings, henyo });
    }
    return henyo;
  } catch {
    return mergeHenyo(undefined).henyo;
  }
}

/**
 * henyo-pi-core extension entry point.
 *
 * This factory function is called by pi when loading the extension.
 * Return a Promise for async initialization (runs before session_start).
 */
export default function (pi: _ExtensionAPI) {
  // ─── Henyo settings ──────────────────────────────────────────────────
  const henyoSettings = loadHenyoSettings();

  // ─── Edit path fix (event hooks only — coexists with tool overrides) ─
  const editPathFixEnabled = resolveEditPathFix(henyoSettings);
  if (editPathFixEnabled) {
    editPathRepairExtension(pi, { enabled: true });
  }

  // ─── Event subscriptions ───────────────────────────────────────────
  const enabledSkillPaths = Object.entries(SKILLS)
    .filter(([name]) => henyoSettings.skills[name] !== false)
    .map(([, path]) => extPath(path));

  if (enabledSkillPaths.length > 0) {
    pi.on('resources_discover', async (_event, _ctx) => {
      return { skillPaths: enabledSkillPaths };
    });
  }

  let footerTui: TUI | undefined;
  let sessionCtx: ExtensionContext | undefined;

  /**
   * Apply the custom footer (or clear it) on the current session.
   * Used by session_start and by the /henyo_footer toggle command.
   */
  function applyFooter(enabled: boolean): void {
    const ctx = sessionCtx;
    if (!ctx) return; // no active session yet — nothing to attach to
    if (enabled) {
      ctx.ui.setFooter((_tui, _theme, footerData) => {
        footerTui = _tui;
        return FooterFactory(_tui, _theme, footerData, ctx, () => pi.getThinkingLevel());
      });
    } else {
      ctx.ui.setFooter(undefined);
    }
  }

  // ─── Lazy init: copy SAMPLE_GLOBAL_AGENTS.md on first session ────
  let agentsMdCopied = false;
  async function ensureAgentsMd() {
    if (agentsMdCopied) return;
    agentsMdCopied = true;
    const src = extPath('SAMPLE_GLOBAL_AGENTS.md');
    const agentDir = getAgentDir();
    const dst = join(agentDir, 'AGENTS.md');
    try {
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.mkdirSync(agentDir, { recursive: true });
        fs.copyFileSync(src, dst);
      }
    } catch {
      // Silently fail — don't break sessions if copy fails
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    sessionCtx = ctx;
    if (henyoSettings.agentsMd !== false) {
      await ensureAgentsMd();
    }
    // Set the custom footer component
    applyFooter(henyoSettings.footer !== false);
  });

  // Re-render footer when model changes
  pi.on('model_select', () => {
    footerTui?.requestRender();
  });

  // Re-render footer when the thinking level changes (suffix is part of line 1)
  pi.on('thinking_level_select', () => {
    footerTui?.requestRender();
  });

  // Re-render footer when session info changes (e.g. session name prefix)
  pi.on('session_info_changed', () => {
    footerTui?.requestRender();
  });

  // ─── Custom commands ───────────────────────────────────────────────
  for (const [cmdName, register] of Object.entries(COMMANDS)) {
    if (henyoSettings.commands[cmdName] !== false) {
      register(pi, applyFooter);
    }
  }
}
