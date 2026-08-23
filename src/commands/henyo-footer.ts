import type { ExtensionAPI as _ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readSettingsFile, writeSettingsFile } from '../settings-io.js';

/**
 * /henyo_footer — live-toggle the henyo custom footer.
 *
 * Flips `henyo.footer` in ~/.pi/agent/settings.json (all other keys and the
 * rest of the `henyo` block are preserved), applies the change to the
 * current session via the `applyFooter` callback, and announces the new
 * state via a TUI notification. Arguments are ignored (toggle only).
 */
export default function henyoFooterCommand(
  pi: _ExtensionAPI,
  applyFooter: (enabled: boolean) => void,
): void {
  pi.registerCommand('henyo_footer', {
    description: 'Toggle the henyo footer',
    handler: async (_args, ctx) => {
      const settings = readSettingsFile();
      const henyoBlock =
        settings.henyo && typeof settings.henyo === 'object' && !Array.isArray(settings.henyo)
          ? settings.henyo
          : {};

      // Default to enabled (matches loadHenyoSettings' defaulting)
      const current = henyoBlock.footer ?? true;
      const next = !current;

      // Write back, preserving all other top-level keys and the henyo block.
      // Silent-fail is guaranteed by writeSettingsFile: a settings write must
      // never break the command.
      settings.henyo = { ...henyoBlock, footer: next };
      writeSettingsFile(settings);

      applyFooter(next);
      ctx.ui.notify(`Henyo footer ${next ? 'enabled' : 'disabled'}`, 'info');
    },
  });
}
