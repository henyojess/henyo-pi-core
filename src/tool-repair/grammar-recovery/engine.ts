/**
 * Grammar-leak recovery engine.
 *
 * Detects leaked tool-call grammar in assistant messages, strips it from the
 * text, and (in recover mode) promotes parsed calls to real toolCalls.
 */

import type {
  Candidate,
  GrammarName,
  GrammarRecoveryOptions,
  GrammarRecoveryResult,
  MinimalAssistantMessage,
  RecoveredToolCall,
  Range,
} from './types.js';
import { ALL_GRAMMARS, GrammarRecoveryMode } from './types.js';
import { modelLeaksGrammar } from './model-gate.js';
import {
  selectCandidates,
  rangesOverlap,
  isAllowedTool,
  removeRanges,
  getPartText,
  setPartText,
  isToolCallContent,
  makeRecoveredToolCallId,
} from './utils.js';
import { parseDsml, parseDsmlDanglingMarkers } from './parsers/dsml.js';
import { parseKimi } from './parsers/kimi.js';
import { parseMistral } from './parsers/mistral.js';
import { parseMiniMaxText01 } from './parsers/minimax.js';
import { parseInvokeXml } from './parsers/invoke.js';
import { parseToolCallXml } from './parsers/qwen.js';
import { parseLlamaPythonTag, parseBareJsonToolCalls } from './parsers/llama.js';
import { parseBarePythonicToolCalls } from './parsers/granite.js';
import { parseOlmo } from './parsers/olmo.js';

export function recoverGrammarLeaks(
  message: MinimalAssistantMessage,
  options: GrammarRecoveryOptions,
): GrammarRecoveryResult {
  const unchanged: GrammarRecoveryResult = {
    changed: false,
    recoveredCalls: [],
    strippedGrammars: [],
    strippedRanges: 0,
    promoted: false,
    message,
  };

  if (options.mode === 'off' || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return unchanged;
  }

  const enabled = new Set(options.grammars ?? ALL_GRAMMARS);
  const requireKnownTool = options.requireKnownTool ?? true;
  const existingToolCalls = message.content.filter(isToolCallContent);
  const recoveredCalls: RecoveredToolCall[] = [];
  const strippedGrammars = new Set<GrammarName>();
  let strippedRanges = 0;
  let changed = false;

  const nextContent = message.content.map((part) => {
    const text = getPartText(part);
    if (text === undefined) return part;

    const candidates = selectCandidates(parseToolGrammarCandidates(text, enabled)).filter(
      (candidate) =>
        candidate.stripOnly || isAllowedTool(candidate.name, requireKnownTool, options.knownTools),
    );

    if (candidates.length === 0) return part;

    strippedRanges += candidates.length;
    changed = true;
    for (const candidate of candidates) {
      strippedGrammars.add(candidate.grammar);
      if (candidate.stripOnly) continue;
      // Safety: a candidate that parsed to an empty argument object is almost
      // always a malformed fragment (e.g. `<tool_call>write</tool_call>`); it
      // would crash as a real call with missing required properties. Skip it.
      if (Object.keys(candidate.arguments).length === 0) continue;
      recoveredCalls.push({
        name: candidate.name,
        arguments: candidate.arguments,
        grammar: candidate.grammar,
      });
    }

    const strippedText = removeRanges(
      text,
      candidates.map((candidate) => candidate.range),
    );
    return setPartText(part, strippedText);
  });

  // Promotion gate: recover mode, no existing real toolCalls, something to
  // promote, AND the original stopReason is "stop" (never overwrite
  // "length"/"error"/"aborted"). Stripping above is allowed regardless.
  const shouldRecover =
    options.mode === 'recover' &&
    existingToolCalls.length === 0 &&
    recoveredCalls.length > 0 &&
    message.stopReason === 'stop';

  if (!changed && !shouldRecover) return unchanged;

  if (shouldRecover) {
    let index = 0;
    for (const call of recoveredCalls) {
      nextContent.push({
        type: 'toolCall',
        id: makeRecoveredToolCallId(call.grammar, index++),
        name: call.name,
        arguments: call.arguments,
      });
    }
  }

  const nextMessage: MinimalAssistantMessage = {
    ...message,
    content: nextContent,
  };
  if (shouldRecover) nextMessage.stopReason = 'toolUse';

  return {
    changed: changed || shouldRecover,
    recoveredCalls: shouldRecover ? recoveredCalls : [],
    strippedGrammars: [...strippedGrammars],
    strippedRanges,
    promoted: shouldRecover,
    message: nextMessage,
  };
}

/** Pure parse: leaked tool calls in text (no stripping, no gates). For tests. */
export function parseToolGrammarLeaks(
  text: string,
  grammars: Iterable<GrammarName> = ALL_GRAMMARS,
): RecoveredToolCall[] {
  const enabled = new Set(grammars);
  return selectCandidates(parseToolGrammarCandidates(text, enabled))
    .filter((candidate) => !candidate.stripOnly)
    .map((candidate) => ({
      name: candidate.name,
      arguments: candidate.arguments,
      grammar: candidate.grammar,
    }));
}

function parseToolGrammarCandidates(text: string, enabled: Set<GrammarName>): Candidate[] {
  const candidates: Candidate[] = [];
  if (enabled.has('dsml')) {
    candidates.push(...parseDsml(text));
    candidates.push(...parseDsmlDanglingMarkers(text));
  }
  if (enabled.has('kimi')) candidates.push(...parseKimi(text));
  if (enabled.has('mistral')) {
    candidates.push(...parseMistral(text));
    candidates.push(...parseBareJsonToolCalls(text, 'mistral'));
  }
  if (enabled.has('minimax-text')) candidates.push(...parseMiniMaxText01(text));
  if (enabled.has('invoke')) candidates.push(...parseInvokeXml(text));
  if (enabled.has('qwen') || enabled.has('glm') || enabled.has('granite')) {
    candidates.push(...parseToolCallXml(text, enabled));
  }
  if (enabled.has('granite')) candidates.push(...parseBarePythonicToolCalls(text, 'granite'));
  if (enabled.has('llama')) {
    candidates.push(...parseLlamaPythonTag(text));
    candidates.push(...parseBareJsonToolCalls(text, 'llama'));
  }
  if (enabled.has('olmo')) candidates.push(...parseOlmo(text));
  return candidates.filter((candidate) => candidate.range.end > candidate.range.start);
}
