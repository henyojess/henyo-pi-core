/**
 * Middleware: Path extraction for the edit tool.
 *
 * Fires when `path` is missing at the top level but present in `edits[0]`.
 * Extracts `edits[0].path` to top-level `path` and removes `path` from all
 * edit objects.
 */

import type { ToolMiddleware } from '../types.js';

/**
 * Middleware for the edit tool: extracts `path` from `edits[0]` to top level.
 *
 * Only fires when:
 * - `path` is missing at the top level
 * - `edits` is an array with at least one element
 * - `edits[0].path` is a string
 */
export const extractPathMiddleware: ToolMiddleware = (input) => {
  const edits = input.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return { changed: false };
  }

  const firstEdit = edits[0];
  if (!firstEdit || typeof firstEdit !== 'object') {
    return { changed: false };
  }

  // Only fire if path is missing at top level
  if ('path' in input) {
    return { changed: false };
  }

  const pathValue = (firstEdit as Record<string, unknown>)['path'];
  if (typeof pathValue !== 'string') {
    return { changed: false };
  }

  // Extract path to top level
  input['path'] = pathValue;

  // Remove path from all edit objects
  for (const edit of edits) {
    if (edit && typeof edit === 'object' && 'path' in edit) {
      delete (edit as Record<string, unknown>)['path'];
    }
  }

  return {
    changed: true,
    note: `Extracted path from edits[0] to top-level \`path\` for tool "${input.toolName || 'edit'}". Put \`path\` at the top level next time.`,
  };
};
