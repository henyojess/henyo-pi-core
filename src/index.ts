import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cwdCommand from "./commands/cwd";
import newpCommand from "./commands/newp";

/**
 * henyo-pi-core extension entry point.
 *
 * This factory function is called by pi when loading the extension.
 * Return a Promise for async initialization (runs before session_start).
 */
export default function (pi: ExtensionAPI) {
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