import { join } from 'node:path';
import fs from 'node:fs';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/**
 * Absolute path to settings.json in the pi agent config dir (honors PI_CODING_AGENT_DIR).
 * Module-level so tests can stub HOME before a dynamic import.
 */
export const SETTINGS_PATH = join(getAgentDir(), 'settings.json');

/**
 * Read the raw settings.json as a plain object.
 * Tolerates a missing file, invalid JSON, or non-object content → {}.
 * (Same policy as loadHenyoSettings' original inline read.)
 */
export function readSettingsFile(): Record<string, any> {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Writes the whole settings.json. Silent-fail — a settings write must never
 * break a session. Callers are responsible for preserving keys this write
 * doesn't know about.
 */
export function writeSettingsFile(data: Record<string, any>): void {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Silently fail — don't break sessions if write fails
  }
}
