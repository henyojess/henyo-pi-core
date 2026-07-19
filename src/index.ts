// @ts-nocheck — vendored submodule (.ext/pi-repair-layer) has its own build/dependencies
// Dynamic import avoids TypeScript following the vendored submodule chain
const { default: toolRepair } = await import('#pi-repair-layer');
import type { ExtensionAPI as _ExtensionAPI } from '@earendil-works/pi-coding-agent';
import cwdCommand from './commands/cwd.js';
import newpCommand from './commands/newp.js';

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
  // pi.on("session_start", ...);
  // pi.on("tool_call", ...);

  // ─── Custom tools ──────────────────────────────────────────────────
  // pi.registerTool({ ... });

  // ─── Custom commands ───────────────────────────────────────────────
  cwdCommand(pi);
  newpCommand(pi);

  // ─── Provider registration (if needed) ─────────────────────────────
  // pi.registerProvider(...);
}
