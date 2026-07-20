import type { ExtensionAPI as _ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

export default function (pi: _ExtensionAPI) {
  pi.registerCommand('cwd', {
    description: 'Switch to another project directory (new session in target dir)',
    handler: async (args, ctx) => {
      // No args — show current CWD
      if (!args || !args.trim()) {
        ctx.ui.notify(`CWD: ${ctx.cwd}`, 'info');
        return;
      }

      const target = resolve(ctx.cwd, args.trim());

      // Validate target is an existing directory
      let statResult: ReturnType<typeof statSync>;
      try {
        statResult = statSync(target);
      } catch {
        ctx.ui.notify(`Path not found: ${args.trim()}`, 'error');
        return;
      }

      if (!statResult.isDirectory()) {
        ctx.ui.notify(`Not a directory: ${target}`, 'error');
        return;
      }

      // Create an in-memory session for the target CWD — no file written until first message.
      const inMemoryManager = SessionManager.inMemory(target);

      const result = await ctx.newSession({
        setup: async (sessionManager) => {
          // Replace the default manager with our in-memory instance so
          // the new session uses the target CWD from the header.
          sessionManager['sessionId'] = inMemoryManager.getSessionId();
          sessionManager['sessionFile'] = inMemoryManager.getSessionFile();
          sessionManager['sessionDir'] = inMemoryManager.getSessionDir();
          sessionManager['cwd'] = target;
        },
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Now in: ${target}`, 'info');
        },
      });

      if (result.cancelled) {
        ctx.ui.notify('Session switch cancelled', 'info');
      }
    },
  });
}
