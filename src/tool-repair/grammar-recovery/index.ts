/**
 * Grammar-leak recovery — public API.
 *
 * Re-exports the public surface of the grammar-recovery module.
 * Internal types and utilities are not exposed.
 */

export {
  GRAMMAR_NAMES,
  type GrammarName,
  type GrammarRecoveryMode,
  type RecoveredToolCall,
  type MinimalAssistantMessage,
  type GrammarRecoveryOptions,
  type GrammarRecoveryResult,
} from "./types.js";

export { modelLeaksGrammar } from "./model-gate.js";

export { recoverGrammarLeaks, parseToolGrammarLeaks } from "./engine.js";
