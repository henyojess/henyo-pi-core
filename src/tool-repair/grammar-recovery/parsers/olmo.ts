/** Olmo grammar-family parser. */

import type { Candidate } from "../types.js";
import {
  isInsideCodeFence,
  parsePythonicCalls,
} from "../utils.js";

function parseOlmo(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const re = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
  for (const match of text.matchAll(re)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    for (const call of parsePythonicCalls(match[1] ?? "")) {
      candidates.push({
        ...call,
        grammar: "olmo",
        range: { start: match.index, end: match.index + match[0].length },
      });
    }
  }
  return candidates;
}

export { parseOlmo };
