/**
 * Type definitions for grammar-leak recovery.
 *
 * Some models print tool-call grammar as literal text instead of emitting
 * real tool calls. These types describe the recovered calls, parsing options,
 * and results of the grammar recovery process.
 */

export const GRAMMAR_NAMES = [
  "dsml",
  "invoke",
  "qwen",
  "kimi",
  "mistral",
  "llama",
  "glm",
  "granite",
  "minimax-text",
  "olmo",
] as const;

export type GrammarName = (typeof GRAMMAR_NAMES)[number];
export type GrammarRecoveryMode = "off" | "strip" | "recover";

export interface RecoveredToolCall {
  name: string;
  arguments: Record<string, unknown>;
  grammar: GrammarName;
}

interface Candidate extends RecoveredToolCall {
  range: Range;
  stripOnly?: boolean;
}

interface Range {
  start: number;
  end: number;
}

interface MinimalTextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface MinimalThinkingContent {
  type: "thinking";
  thinking: string;
  [key: string]: unknown;
}

interface MinimalToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  [key: string]: unknown;
}

type MinimalAssistantContent =
  | MinimalTextContent
  | MinimalThinkingContent
  | MinimalToolCallContent
  | Record<string, unknown>;

export interface MinimalAssistantMessage {
  role: string;
  content: MinimalAssistantContent[];
  stopReason?: string;
  [key: string]: unknown;
}

export interface GrammarRecoveryOptions {
  mode: GrammarRecoveryMode;
  /** Active/allowed tool names; a leaked call is only promoted if its name is here. */
  knownTools: Set<string>;
  /** Which grammar families to detect. Default: all. */
  grammars?: readonly GrammarName[];
  /** Require the recovered tool name to be in `knownTools`. Default: true. */
  requireKnownTool?: boolean;
}

export interface GrammarRecoveryResult {
  /** Whether the message was modified (text stripped and/or calls promoted). */
  changed: boolean;
  /** Calls promoted to real toolCalls (empty unless a promotion happened). */
  recoveredCalls: RecoveredToolCall[];
  /** Distinct grammar families whose leaked text was stripped. */
  strippedGrammars: GrammarName[];
  /** Number of leaked ranges removed from text. */
  strippedRanges: number;
  /** True when calls were promoted and stopReason was set to "toolUse". */
  promoted: boolean;
  /** The replacement message (same object when unchanged). */
  message: MinimalAssistantMessage;
}

/** All grammar families, used as the default when no filter is provided. */
const ALL_GRAMMARS = [...GRAMMAR_NAMES];

export { Candidate, Range, Candidate as CandidateType, Range as RangeType };
export { ALL_GRAMMARS };
