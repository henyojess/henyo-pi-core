/**
 * Public API barrel for the tool-repair module — re-exports the 12 original
 * public symbols from `src/tool-repair.ts` (now the re-export shim) so the
 * legacy `./tool-repair.js` import path stays byte-compatible for all
 * importers (`src/index.ts`, `src/commands/henyo.ts`, tests).
 */
export {
  dropIncompleteEdits,
  hoistEditPath,
  recoverGarbledPath,
  repairStringifiedEdits,
  salvageCorruptEdits,
} from './rules.js';
export {
  classifyEmission,
  editLocationFingerprint,
  normalizeForFingerprint,
} from './fingerprint.js';
export type { EmissionClass } from './fingerprint.js';
export { resolveEditFallback, resolveToolRepair, toolRepairExtension } from './hooks.js';
