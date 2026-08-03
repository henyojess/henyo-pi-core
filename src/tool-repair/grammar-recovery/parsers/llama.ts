/** Llama grammar-family parser. */

import type { Candidate, GrammarName } from "../types.js";
import {
  callsFromJsonValue,
  extractFirstBalancedJson,
  findLineEnd,
  isInsideCodeFence,
  parseJsonValue,
  parsePythonicCalls,
} from "../utils.js";

function parseLlamaPythonTag(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const marker = "<|python_tag|>";
  let index = 0;

  for (
    index = text.indexOf(marker, index);
    index !== -1;
    index = text.indexOf(marker, index)
  ) {
    if (isInsideCodeFence(text, index)) {
      index += marker.length;
      continue;
    }
    const bodyStart = index + marker.length;
    const rest = text.slice(bodyStart).trimStart();
    const whitespace = text.slice(bodyStart).length - rest.length;
    const payloadStart = bodyStart + whitespace;

    const extracted = extractFirstBalancedJson(text.slice(payloadStart));
    if (extracted) {
      const parsed = parseJsonValue(extracted.json);
      for (const call of callsFromJsonValue(parsed)) {
        candidates.push({
          ...call,
          grammar: "llama",
          range: { start: index, end: payloadStart + extracted.end },
        });
      }
      index = payloadStart + extracted.end;
      continue;
    }

    const lineEnd = findLineEnd(text, payloadStart);
    for (const call of parsePythonicCalls(text.slice(payloadStart, lineEnd))) {
      candidates.push({
        ...call,
        grammar: "llama",
        range: { start: index, end: lineEnd },
      });
    }
    index = lineEnd;
  }

  return candidates;
}

function parseBareJsonToolCalls(
  text: string,
  grammar: GrammarName,
): Candidate[] {
  const candidates: Candidate[] = [];
  const objectRe = /\{\s*"(?:name|function_name|function)"/g;

  for (const match of text.matchAll(objectRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const extracted = extractFirstBalancedJson(text.slice(match.index));
    if (!extracted) continue;
    for (const call of callsFromJsonValue(parseJsonValue(extracted.json))) {
      candidates.push({
        ...call,
        grammar,
        range: { start: match.index, end: match.index + extracted.end },
      });
    }
  }

  const arrayRe = /\[\s*\{\s*"(?:name|function_name|function)"/g;
  for (const match of text.matchAll(arrayRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const extracted = extractFirstBalancedJson(text.slice(match.index));
    if (!extracted) continue;
    for (const call of callsFromJsonValue(parseJsonValue(extracted.json))) {
      candidates.push({
        ...call,
        grammar,
        range: { start: match.index, end: match.index + extracted.end },
      });
    }
  }

  return candidates;
}

export { parseLlamaPythonTag, parseBareJsonToolCalls };
