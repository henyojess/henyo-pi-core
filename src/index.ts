// Inline modular repair layer

import toolRepairExtension from './tool-repair/index.js';
import type { ExtensionAPI as _ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import cwdCommand from './commands/cwd.js';
import newpCommand from './commands/newp.js';
import { FooterFactory } from './footer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve a path relative to this extension's installed location. */
function extPath(...segments: string[]) {
  return join(__dirname, '..', ...segments);
}

// ─── Henyo Settings Block ──────────────────────────────────────────────

interface HenyoSettings {
  toolRepair: boolean;
  footer: boolean;
  agentsMd: boolean;
  skills: Record<string, boolean>;
  commands: Record<string, boolean>;
}

const SETTINGS_PATH = join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.pi',
  'agent',
  'settings.json',
);
const FEATURE_KEYS: (keyof Omit<HenyoSettings, 'skills' | 'commands'>)[] = [
  'toolRepair',
  'footer',
  'agentsMd',
];
const SKILLS = { 'plan-generation': 'skills/plan-generation', notes: 'skills/notes' };
const COMMANDS = { cwd: cwdCommand, newp: newpCommand };

/**
 * Load henyo settings from ~/.pi/agent/settings.json.
 * Returns merged settings with all defaults filled in.
 * If the henyo block is missing or incomplete, writes defaults back.
 */
function loadHenyoSettings(): HenyoSettings {
  try {
    let settings: any = {};
    let henyo: any = {};
    let changed = false;

    // Read existing settings
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      } catch {
        // Invalid JSON — start fresh
        settings = {};
      }
    }

    // Extract henyo block
    if (settings.henyo && typeof settings.henyo === 'object' && !Array.isArray(settings.henyo)) {
      henyo = settings.henyo;
    } else {
      changed = true;
    }

    // Fill default feature keys
    for (const key of FEATURE_KEYS) {
      if (!(key in henyo)) {
        henyo[key] = true;
        changed = true;
      }
    }

    // Fill default skills
    if (!henyo.skills || typeof henyo.skills !== 'object' || Array.isArray(henyo.skills)) {
      henyo.skills = {};
      changed = true;
    }
    for (const skillName of Object.keys(SKILLS)) {
      if (!(skillName in henyo.skills)) {
        henyo.skills[skillName] = true;
        changed = true;
      }
    }

    // Fill default commands
    if (!henyo.commands || typeof henyo.commands !== 'object' || Array.isArray(henyo.commands)) {
      henyo.commands = {};
      changed = true;
    }
    for (const cmdName of Object.keys(COMMANDS)) {
      if (!(cmdName in henyo.commands)) {
        henyo.commands[cmdName] = true;
        changed = true;
      }
    }

    // Write back if changed
    if (changed) {
      settings.henyo = henyo;
      try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
      } catch {
        // Silently fail — don't break sessions if write fails
      }
    }

    return henyo;
  } catch {
    // Never throw — return all-defaults
    return {
      toolRepair: true,
      footer: true,
      agentsMd: true,
      skills: { 'plan-generation': true, notes: true },
      commands: { cwd: true, newp: true },
    };
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

  // ─── Tool repair (must run first — overrides built-in tools) ────────
  if (henyoSettings.toolRepair !== false) {
    toolRepairExtension(pi);
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

  let footerComponent: any;
  let footerTui: TUI | undefined;

  // ─── Lazy init: copy SAMPLE_GLOBAL_AGENTS.md on first session ────
  let agentsMdCopied = false;
  async function ensureAgentsMd() {
    if (agentsMdCopied) return;
    agentsMdCopied = true;
    const src = extPath('SAMPLE_GLOBAL_AGENTS.md');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const dst = join(home, '.pi', 'agent', 'AGENTS.md');
    try {
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    } catch {
      // Silently fail — don't break sessions if copy fails
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    if (henyoSettings.agentsMd !== false) {
      await ensureAgentsMd();
    }
    // Set the custom footer component
    if (henyoSettings.footer !== false) {
      ctx.ui.setFooter((_tui, _theme, footerData) => {
        footerTui = _tui;
        const component = FooterFactory(_tui, _theme, footerData, ctx, () => pi.getThinkingLevel());
        footerComponent = component;
        return component;
      });
    } else {
      ctx.ui.setFooter(undefined);
    }
  });

  // Invalidate footer when model changes
  pi.on('model_select', () => {
    footerComponent?.invalidate();
    footerTui?.requestRender();
  });

  // Re-render footer when the thinking level changes (suffix is part of line 1)
  pi.on('thinking_level_select', () => {
    footerComponent?.invalidate();
    footerTui?.requestRender();
  });

  // Re-render footer when session info changes (e.g. session name prefix)
  pi.on('session_info_changed', () => {
    footerComponent?.invalidate();
    footerTui?.requestRender();
  });

  // ─── Custom tools ──────────────────────────────────────────────────
  // pi.registerTool({ ... });

  // ─── Custom commands ───────────────────────────────────────────────
  for (const [cmdName, register] of Object.entries(COMMANDS)) {
    if (henyoSettings.commands[cmdName] !== false) {
      register(pi);
    }
  }

  // ─── Provider registration (if needed) ─────────────────────────────
  // pi.registerProvider(...);
}
