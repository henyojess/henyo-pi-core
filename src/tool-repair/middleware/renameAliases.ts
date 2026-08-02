/**
 * Middleware: Aliased field renaming.
 *
 * Fires when a known alias is present and the canonical field is missing/null/empty.
 * Renames the alias to the canonical field name.
 */

import type { ToolMiddleware } from "../types.js";

/**
 * Create a middleware that renames known aliases to canonical field names.
 *
 * @param aliases — Map of canonical field name → list of alias names.
 */
export function createRenameAliasesMiddleware(
  aliases: Record<string, readonly string[]>,
): ToolMiddleware {
  return (input) => {
    let changed = false;
    const notes: string[] = [];

    for (const [canonical, aliasList] of Object.entries(aliases)) {
      for (const alias of aliasList) {
        if (!(alias in input)) continue;
        const value = input[alias];
        // Skip null, undefined, or empty string values at the alias
        if (value == null || value === "") continue;
        // Skip if the canonical field already has a non-trivial value
        if (
          canonical in input &&
          input[canonical] !== undefined &&
          input[canonical] !== null &&
          input[canonical] !== ""
        ) {
          continue;
        }

        input[canonical] = value;
        delete input[alias];
        changed = true;
        notes.push(
          `Renamed \`${alias}\` to \`${canonical}\` for tool. Use \`${canonical}\` next time — \`${alias}\` is not a valid field for this tool.`,
        );
      }
    }

    if (!changed) return { changed: false };
    return { changed: true, note: notes.join("; ") };
  };
}
