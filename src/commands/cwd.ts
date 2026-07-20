import type { ExtensionAPI as _ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';

/** Generate a simple session ID (matches pi's internal format). */
function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

/**
 * Compute the default session directory for a given CWD.
 * Mirrors pi's internal getDefaultSessionDirPath logic.
 */
function getSessionDirForCwd(cwd: string): string {
  const agentDir = join(homedir(), '.pi', 'agent');
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
  return join(agentDir, 'sessions', safePath);
}

/**
 * Check if a session file is empty (contains only the header, no messages).
 */
function isSessionEmpty(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content
      .trimEnd()
      .split('\n')
      .filter((l) => l.trim());
    return lines.length <= 1;
  } catch {
    return false;
  }
}

/**
 * Create a minimal session header file in the correct session directory
 * for the target CWD. The file is used as a transport for switchSession
 * and is deleted afterward only if still empty (no user messages).
 * Pi's session manager persists to the correct location on first message.
 */
function createTempSessionFile(target: string): string {
  const sessionId = generateSessionId();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionDir = getSessionDirForCwd(target);

  // Ensure the session directory exists
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  const sessionFile = join(sessionDir, `${timestamp}_${sessionId}.jsonl`);

  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: target,
  };

  writeFileSync(sessionFile, JSON.stringify(header) + '\n', 'utf-8');
  return sessionFile;
}

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

      // Create a session file with the correct CWD in its header in the
      // target's session directory. switchSession reads CWD from the
      // session file so the runner gets the correct cwd. We delete the
      // file afterward so empty sessions don't pollute /resume — pi
      // persists to the correct location when the user sends their first message.
      const sessionFile = createTempSessionFile(target);

      const result = await ctx.switchSession(sessionFile, {
        withSession: async (newCtx) => {
          // Only delete the temp file if it's still empty (no user messages).
          // If the user already sent a message, pi persisted to the file and
          // it should be kept.
          if (isSessionEmpty(sessionFile)) {
            try {
              unlinkSync(sessionFile);
            } catch {
              // File may already be gone; ignore
            }
          }
          newCtx.ui.notify(`Now in: ${target}`, 'info');
        },
      });

      if (result.cancelled) {
        // Clean up the temp file if the switch was cancelled
        try {
          unlinkSync(sessionFile);
        } catch {
          // File may already be gone; ignore
        }
        ctx.ui.notify('Session switch cancelled', 'info');
      }
    },
  });
}
