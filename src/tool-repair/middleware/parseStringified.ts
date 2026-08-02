/**
 * Middleware: Stringified array/object parsing.
 *
 * Fires when an issue site expects an array or object but receives a string
 * that starts with `[` or `{`. Attempts JSON.parse, with a Python-style
 * syntax fallback (single-quote to double-quote conversion).
 */

import type { ToolMiddleware } from "../types.js";

interface IssueSite {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  expected?: string;
}

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
 * Python-style fallback: convert single-quoted syntax to double-quoted JSON.
 * e.g. `{'a': 1}` → `{"a": 1}`
 */
function pythonToJson(text: string): string | undefined {
  // Must start with { or [ and end with } or ]
  if (!text.match(/^[{\[]/)) return undefined;
  if (!text.match(/[}\]]$/)) return undefined;

  let result = text;

  // Convert single-quoted keys and values to double-quoted
  // Match 'key': or 'value' patterns
  result = result.replace(
    /'([^'\\]|\\.)*'/g,
    (match) => `"${match.slice(1, -1).replace(/"/g, '\\"')}"`,
  );

  // Validate the result is valid JSON
  try {
    JSON.parse(result);
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Create a middleware that parses JSON-stringified arrays and objects at issue sites.
 *
 * @param expectedTypes — List of JSON types this middleware handles (e.g. ['array', 'object']).
 */
export function createParseStringifiedMiddleware(
  expectedTypes: string[] = ["array", "object"],
): ToolMiddleware {
  return (input, ctx) => {
    if (!ctx.issues || ctx.issues.length === 0) {
      return { changed: false };
    }

    let changed = false;
    const notes: string[] = [];

    for (const issue of ctx.issues) {
      const segments = issue.instancePath
        .split("/")
        .filter((s) => s.length > 0);
      if (segments.length === 0) continue; // root-level

      // Resolve the parent container
      let parent: unknown = input;
      for (let i = 0; i < segments.length - 1; i++) {
        if (!isPlainObject(parent) && !Array.isArray(parent)) {
          parent = undefined;
          break;
        }
        parent = (parent as Record<string | number, unknown>)[segments[i]];
      }

      if (!isPlainObject(parent) && !Array.isArray(parent)) continue;

      const key = segments[segments.length - 1];
      if (typeof key !== "string" && typeof key !== "number") continue;

      const value = (parent as Record<string | number, unknown>)[key];
      if (typeof value !== "string") continue;

      // Check if the expected type matches
      const expected =
        typeof issue.params?.type === "string"
          ? issue.params.type
          : undefined;
      if (expected && !expectedTypes.includes(expected)) continue;

      const trimmed = value.trim();

      // Try JSON parse first
      let parsed: unknown;
      if (expected === "array" && trimmed.startsWith("[") && trimmed.endsWith("]")) {
        parsed = tryParseJson(trimmed);
        if (Array.isArray(parsed)) {
          (parent as Record<string | number, unknown>)[key] = parsed;
          changed = true;
          notes.push(
            `Parsed JSON-stringified array for \`${key}\` in tool "${ctx.toolName}". Send the array literal directly next time, not a string.`,
          );
          continue;
        }
        // Python-style fallback
        const pythonJson = pythonToJson(trimmed);
        if (pythonJson) {
          const pyParsed = JSON.parse(pythonJson);
          if (Array.isArray(pyParsed)) {
            (parent as Record<string | number, unknown>)[key] = pyParsed;
            changed = true;
            notes.push(
              `Parsed Python-style array syntax for \`${key}\` in tool "${ctx.toolName}". Send JSON array syntax next time.`,
            );
            continue;
          }
        }
      } else if (
        expected === "object" &&
        trimmed.startsWith("{") &&
        trimmed.endsWith("}")
      ) {
        parsed = tryParseJson(trimmed);
        if (isPlainObject(parsed)) {
          (parent as Record<string | number, unknown>)[key] = parsed;
          changed = true;
          notes.push(
            `Parsed JSON-stringified object for \`${key}\` in tool "${ctx.toolName}". Send the object literal directly next time, not a string.`,
          );
          continue;
        }
        // Python-style fallback
        const pythonJson = pythonToJson(trimmed);
        if (pythonJson) {
          const pyParsed = JSON.parse(pythonJson);
          if (isPlainObject(pyParsed)) {
            (parent as Record<string | number, unknown>)[key] = pyParsed;
            changed = true;
            notes.push(
              `Parsed Python-style object syntax for \`${key}\` in tool "${ctx.toolName}". Send JSON object syntax next time.`,
            );
            continue;
          }
        }
      }
    }

    if (!changed) return { changed: false };
    return { changed: true, note: notes.join("; ") };
  };
}
