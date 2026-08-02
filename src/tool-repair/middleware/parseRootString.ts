/**
 * Middleware: Root string parsing.
 *
 * Fires when the whole input is a JSON string. Tries `JSON.parse` — if the
 * result is a plain object, replaces the input with it.
 */

import type { ToolMiddleware } from "../types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Middleware that handles when the whole input is a JSON string.
 *
 * @param field — The canonical field name to use if wrapping a bare string.
 */
export function createParseRootStringMiddleware(
  field?: string,
): ToolMiddleware {
  return (input, ctx) => {
    // input is always a Record at this point (engine guards this)
    const current = input as Record<string, unknown>;

    // Check if the entire input is a single-key object with a string value
    // that looks like a JSON-stringified object
    const entries = Object.entries(current);
    if (entries.length !== 1) {
      return { changed: false };
    }

    const [key, value] = entries[0];
    if (typeof value !== "string") return { changed: false };

    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      return { changed: false };
    }

    const parsed = tryParseJson(trimmed);
    if (!isPlainObject(parsed)) return { changed: false };

    // Replace the entire input with the parsed object
    for (const k of Object.keys(current)) {
      delete current[k];
    }
    Object.assign(current, parsed);

    return {
      changed: true,
      note: `Parsed JSON-stringified arguments for tool "${ctx.toolName}". Send the arguments as a JSON object next time, not a string.`,
    };
  };
}
