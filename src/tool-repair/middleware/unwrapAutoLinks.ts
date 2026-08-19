/**
 * Middleware: Markdown auto-link unwrapping on path-type fields.
 *
 * Fires when a string field value is a markdown auto-link where the link text
 * equals the URL without its protocol — e.g. `[notes.md](http://notes.md)`
 * becomes `notes.md`. Real markdown links pass through untouched.
 */

import type { ToolMiddleware } from '../types.js';

const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const PROTOCOL = /^https?:\/\//;

/**
 * Unwrap a single value if it's a degenerate markdown auto-link.
 * Returns the unwrapped value, or the original if no unwrap was needed.
 */
function tryUnwrap(value: string): string {
  return value.replace(MARKDOWN_LINK, (_match, text: string, url: string) =>
    url.replace(PROTOCOL, '') === text ? text : _match,
  );
}

/**
 * Create a middleware that unwraps auto-links on specific fields.
 *
 * @param fields — List of field names to check for auto-link unwrapping.
 */
export function createUnwrapAutoLinksMiddleware(fields: readonly string[]): ToolMiddleware {
  return (input, ctx) => {
    let changed = false;
    let notes: string[] = [];

    for (const field of fields) {
      const value = input[field];
      if (typeof value !== 'string') continue;
      const unwrapped = tryUnwrap(value);
      if (unwrapped === value) continue;
      input[field] = unwrapped;
      changed = true;
      notes.push(
        `Unwrapped markdown auto-link in \`${field}\` for tool "${ctx.toolName}" (\`${value}\` -> \`${unwrapped}\`). Send plain paths, not markdown links.`,
      );
    }

    if (!changed) return { changed: false };
    return { changed: true, note: notes.join('; ') };
  };
}
