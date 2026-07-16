import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cwd", {
    description: "Switch to another project directory (new session in target dir)",
    handler: async (args, ctx) => {
      // No args — show current CWD
      if (!args || !args.trim()) {
        ctx.ui.notify(`CWD: ${ctx.cwd}`, 'info');
        return;
      }

      const target = resolve(ctx.cwd, args.trim());

      // Validate target is an existing directory
      try {
        const stat = statSync(target);
        if (!stat.isDirectory()) {
          ctx.ui.notify(`Not a directory: ${target}`, 'error');
          return;
        }
      } catch {
        ctx.ui.notify(`Path not found: ${target}`, 'error');
        return;
      }

      // Create a new session in the target directory's own session folder.
      // SessionManager.create() derives both the session file path and the
      // session directory from the target CWD, so everything stays consistent.
      const newSession = SessionManager.create(target);
      const sessionFile = newSession.getSessionFile();

      if (!sessionFile) {
        ctx.ui.notify('Failed to create new session', 'error');
        return;
      }

      const sessionId = newSession.getSessionId();
      const header = {
        type: "session" as const,
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: target,
      };

      // Ensure the target session directory exists
      const sessionDir = newSession.getSessionDir();
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }

      writeFileSync(sessionFile, JSON.stringify(header) + "\n", "utf-8");

      // Switch to the new session — it reads CWD from the header
      const result = await ctx.switchSession(sessionFile, {
        withSession: async (newCtx) => {
          newCtx.ui.notify(`Now in: ${newCtx.cwd}`, 'info');
        },
      });

      if (result.cancelled) {
        ctx.ui.notify('Session switch cancelled', 'info');
      }
    },
  });
}
