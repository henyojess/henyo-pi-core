/**
 * Tool-specific repair configurations.
 *
 * Each tool gets a `ToolRepairConfig` with its TypeBox schema, ordered middleware
 * list, field aliases, and path fields for auto-link unwrapping.
 */

import type { ToolRepairConfig } from "./types.js";
import { createUnwrapAutoLinksMiddleware } from "./middleware/unwrapAutoLinks.js";
import { createParseRootStringMiddleware } from "./middleware/parseRootString.js";
import { createRenameAliasesMiddleware } from "./middleware/renameAliases.js";
import { createParseStringifiedMiddleware } from "./middleware/parseStringified.js";
import { extractPathMiddleware } from "./middleware/extractPath.js";

// ---------------------------------------------------------------------------
// Retry examples — model-readable examples for unrepairable inputs
// ---------------------------------------------------------------------------

export const RETRY_EXAMPLES: Record<string, string> = {
  edit: `{ "path": "/file.txt", "edits": [{ "oldText": "...", "newText": "..." }] }`,
};

// ---------------------------------------------------------------------------
// Edit tool config
// ---------------------------------------------------------------------------

/**
 * TypeBox schema for the edit tool's parameters.
 *
 * This is a simplified schema that matches the expected structure.
 * In production, this would be imported from the tool's actual schema definition.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const editSchema: any = {
  type: "object",
  required: ["path", "edits"],
  properties: {
    path: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        required: ["oldText", "newText"],
        properties: {
          oldText: { type: "string" },
          newText: { type: "string" },
          options: {
            type: "object",
            properties: {
              validateOptions: { type: "boolean" },
              ignoreChanges: { type: "string" },
              ignoreWhitespace: { type: "boolean" },
            },
          },
        },
      },
    },
    dryRun: { type: "boolean" },
  },
};

/**
 * Field aliases for the edit tool — common variations the model might emit.
 */
const EDIT_ALIASES: Record<string, readonly string[]> = {
  path: ["file_path", "filePath"],
  oldText: ["old_text", "oldText"],
  newText: ["new_text", "newText"],
};

/**
 * Path-type fields in the edit tool — subject to markdown auto-link unwrapping.
 */
const EDIT_PATH_FIELDS: readonly string[] = ["path"];

/**
 * Repair configuration for the edit tool.
 *
 * Middleware order matters:
 * 1. unwrapAutoLinks — fix `[path.md](http://path.md)` → `path.md`
 * 2. parseRootString — handle `{ "path": '{"edits":...}' }`
 * 3. extractPath — move `edits[0].path` to top-level `path`
 * 4. parseStringified — parse JSON-stringified arrays/objects at issue sites
 * 5. renameAliases — rename `file_path` → `path`, etc.
 */
export const editConfig: ToolRepairConfig = {
  schema: editSchema,
  middleware: [
    createUnwrapAutoLinksMiddleware(EDIT_PATH_FIELDS),
    createParseRootStringMiddleware(),
    extractPathMiddleware,
    createParseStringifiedMiddleware(["array", "object"]),
    createRenameAliasesMiddleware(EDIT_ALIASES),
  ],
  fieldAliases: EDIT_ALIASES,
  pathFields: EDIT_PATH_FIELDS,
};
