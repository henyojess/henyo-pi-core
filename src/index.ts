// @ts-nocheck — vendored submodule (.ext/pi-repair-layer) has its own build/dependencies
// Dynamic import avoids TypeScript following the vendored submodule chain
const { default: toolRepair } = await import('#pi-repair-layer');
import type { ExtensionAPI as _ExtensionAPI } from '@earendil-works/pi-coding-agent';
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

/**
 * henyo-pi-core extension entry point.
 *
 * This factory function is called by pi when loading the extension.
 * Return a Promise for async initialization (runs before session_start).
 */
export default function (pi: _ExtensionAPI) {
  // ─── Tool repair (must run first — overrides built-in tools) ────────
  toolRepair(pi);

  // ─── Event subscriptions ───────────────────────────────────────────
  pi.on('resources_discover', async (_event, _ctx) => {
    return {
      skillPaths: [extPath('skills', 'plan-generation'), extPath('skills', 'notes')],
    };
  });

  let footerComponent: any;

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
    await ensureAgentsMd();
    // Set the custom footer component
    ctx.ui.setFooter((_tui, _theme, footerData) => {
      const component = FooterFactory(_tui, _theme, footerData, ctx);
      footerComponent = component;
      return component;
    });
  });

  // Invalidate footer when model changes
  pi.on('model_select', () => {
    if (footerComponent) {
      footerComponent.invalidate();
    }
  });

  // ─── Custom tools ──────────────────────────────────────────────────
  // pi.registerTool({ ... });

  // ─── Custom commands ───────────────────────────────────────────────
  cwdCommand(pi);
  newpCommand(pi);

  // ─── Provider registration (if needed) ─────────────────────────────
  // pi.registerProvider(...);
}
