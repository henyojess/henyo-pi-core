import type {
  ExtensionAPI as _ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { readSettingsFile, writeSettingsFile } from '../settings-io.js';
import { getEffectiveHenyoSettings } from '../henyo-settings.js';
import { resolveEditPathFix } from '../edit-path-repair.js';
import type { HenyoSettings } from '../henyo-settings.js';

/**
 * /henyo — list or toggle all henyo features from the TUI.
 *
 * Usage:
 *   /henyo                 picker of all 9 keys ("key: on/off", pick to toggle)
 *   /henyo <key>           flip the current effective state of <key>
 *   /henyo <key> <value>   set <key> to <value> (on|off|true|false|enable|disable)
 *
 * Keys accept the canonical dotted form or a flat shorthand (`notes`,
 * `plan-generation`, `cwd`, `newp`). `footer` applies live via the
 * `applyFooter` callback; every other key is written and applied after
 * `ctx.reload()` (terminal — the success toast precedes the reload).
 */

interface KeyInfo {
  canonical: string;
  /** Flat shorthand accepted in place of the canonical key (unique). */
  shorthand?: string;
  /** Nested settings section (`skills`/`commands`) — top-level otherwise. */
  section?: 'skills' | 'commands';
  /** Applied in-session without a reload (footer only). */
  live?: boolean;
}

/** Key registry — order = picker/completion order. */
const KEYS: KeyInfo[] = [
  { canonical: 'editPathFix' },
  { canonical: 'footer', live: true },
  { canonical: 'agentsMd' },
  { canonical: 'skills.plan-generation', shorthand: 'plan-generation', section: 'skills' },
  { canonical: 'skills.notes', shorthand: 'notes', section: 'skills' },
  { canonical: 'commands.cwd', shorthand: 'cwd', section: 'commands' },
  { canonical: 'commands.newp', shorthand: 'newp', section: 'commands' },
  { canonical: 'ttftTokps' },
  { canonical: 'trace' },
];

const VALID_KEYS = KEYS.map((k) => k.canonical).join(', ');
const VALUE_HINT = 'on, off, true, false, enable or disable';

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical key for a token (canonical or shorthand, case-sensitive). */
function resolveKey(token: string): KeyInfo | undefined {
  return KEYS.find((k) => k.canonical === token || k.shorthand === token);
}

/** Parse one of the 6 accepted values case-insensitively. */
function parseValue(token: string): boolean | undefined {
  const v = token.toLowerCase();
  if (v === 'on' || v === 'true' || v === 'enable') return true;
  if (v === 'off' || v === 'false' || v === 'disable') return false;
  return undefined;
}

/** Effective (display) state of a key from merged settings. */
function effectiveState(settings: HenyoSettings, key: KeyInfo): boolean {
  if (key.canonical === 'editPathFix') {
    return resolveEditPathFix(settings); // honors legacy toolRepair
  }
  if (key.section) {
    return settings[key.section][key.canonical.split('.')[1]] !== false;
  }
  return settings[key.canonical as 'footer' | 'agentsMd' | 'ttftTokps' | 'trace'];
}

/** Write one key's value, preserving the rest of the settings file. */
function writeKey(key: KeyInfo, value: boolean): void {
  const settings = readSettingsFile();
  const henyoBlock = isPlainObject(settings.henyo) ? settings.henyo : {};
  if (key.section) {
    const section = isPlainObject(henyoBlock[key.section]) ? henyoBlock[key.section] : {};
    henyoBlock[key.section] = { ...section, [key.canonical.split('.')[1]]: value };
  } else {
    henyoBlock[key.canonical] = value;
  }
  settings.henyo = henyoBlock;
  writeSettingsFile(settings);
}

/**
 * Argument completions (see plan decision #6 — pi passes `prefix` =
 * everything after the first space and replaces the whole argument text
 * with the accepted item's `value`):
 *  - token 1 (no space in prefix): the 9 keys, `startsWith` on canonical
 *    OR shorthand (case-sensitive), `value` = canonical.
 *  - token 2 (space in prefix): the 6 values filtered by the last token,
 *    only when the first token matches a key; `value` = "<key> <val>"
 *    (full argument), `label` = "<val>".
 *  - no match → null (pi shows nothing).
 */
function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  if (!prefix.includes(' ')) {
    const matches = KEYS.filter(
      (k) => k.canonical.startsWith(prefix) || (k.shorthand ?? '').startsWith(prefix),
    );
    if (matches.length === 0) return null;
    return matches.map((k) => ({
      value: k.canonical,
      label: k.canonical,
      ...(k.shorthand ? { description: `alias: /henyo ${k.shorthand}` } : {}),
    }));
  }
  const parts = prefix.trimEnd().split(/\s+/);
  const key = resolveKey(parts[0]);
  if (!key) return null;
  const last = parts[parts.length - 1] ?? '';
  const values = ['on', 'off', 'true', 'false', 'enable', 'disable'].filter((v) =>
    v.startsWith(last),
  );
  if (values.length === 0) return null;
  return values.map((v) => ({ value: `${key.canonical} ${v}`, label: v }));
}

/** Write one key's value, apply it (live for footer, reload for others). */
async function toggle(
  ctx: ExtensionCommandContext,
  applyFooter: (enabled: boolean) => void,
  key: KeyInfo,
  next: boolean,
): Promise<void> {
  writeKey(key, next);
  if (key.live) {
    applyFooter(next);
    if (ctx.hasUI) {
      ctx.ui.notify(`Henyo footer ${next ? 'enabled' : 'disabled'}`, 'info');
    }
  } else {
    if (ctx.hasUI) {
      ctx.ui.notify(`Henyo ${key.canonical} ${next ? 'enabled' : 'disabled'} — reloading`, 'info');
    }
    await ctx.reload(); // terminal per pi docs — notify precedes it
  }
}

export default function henyoCommand(
  pi: _ExtensionAPI,
  applyFooter: (enabled: boolean) => void,
): void {
  pi.registerCommand('henyo', {
    description: 'List or toggle henyo features',
    getArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);

      if (tokens.length > 2) {
        if (ctx.hasUI) {
          ctx.ui.notify('Usage: /henyo <key> [on|off|true|false|enable|disable]', 'error');
        }
        return;
      }

      const settings = getEffectiveHenyoSettings();

      // 0 tokens: picker (TUI only).
      if (tokens.length === 0) {
        if (!ctx.hasUI) return;
        const labels = KEYS.map(
          (k) => `${k.canonical}: ${effectiveState(settings, k) ? 'on' : 'off'}`,
        );
        const choice = await ctx.ui.select('Henyo features (pick to toggle):', labels);
        if (choice === undefined) return;
        const key = resolveKey(choice.split(': ')[0]);
        if (!key) return;
        await toggle(ctx, applyFooter, key, !effectiveState(settings, key));
        return;
      }

      const key = resolveKey(tokens[0]);
      if (!key) {
        if (ctx.hasUI)
          ctx.ui.notify(`Unknown henyo key "${tokens[0]}". Valid keys: ${VALID_KEYS}`, 'error');
        return;
      }

      // 2 tokens → explicit value; 1 token → flip the effective state.
      let next: boolean;
      if (tokens.length === 2) {
        const parsed = parseValue(tokens[1]);
        if (parsed === undefined) {
          if (ctx.hasUI) {
            ctx.ui.notify(`Invalid value "${tokens[1]}" — use ${VALUE_HINT}`, 'error');
          }
          return;
        }
        next = parsed;
      } else {
        next = !effectiveState(settings, key);
      }

      await toggle(ctx, applyFooter, key, next);
    },
  });
}
