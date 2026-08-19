import { join } from 'node:path';
import fs from 'node:fs';

/**
 * Absolute path to ~/.pi/agent/settings.json.
 * Module-level so tests can stub HOME before a dynamic import.
 */
export const SETTINGS_PATH = join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.pi',
  'agent',
  'settings.json',
);

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
