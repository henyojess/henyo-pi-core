/** Granite grammar-family parser (bare Pythonic tool calls). */

import type { Candidate, GrammarName } from "../types.js";
import {
  findMatching,
  isInsideCodeFence,
  parsePythonicCalls,
} from "../utils.js";

function parseBarePythonicToolCalls(
  text: string,
  grammar: GrammarName,
): Candidate[] {
  const candidates: Candidate[] = [];
  const lineRe = /(?:^|\n)\s*([A-Za-z_][\w.-]*)\s*\(/g;

  for (const match of text.matchAll(lineRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const openParen = match.index + match[0].lastIndexOf("(");
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen === undefined) continue;
    const lineStart = text.lastIndexOf("\n", openParen) + 1;
    if (text.slice(lineStart, match.index).trim() !== "") continue;
    const [call] = parsePythonicCalls(text.slice(start, closeParen + 1));
    if (call)
      candidates.push({
        ...call,
        grammar,
        range: { start, end: closeParen + 1 },
      });
  }

  return candidates;
}

export { parseBarePythonicToolCalls };
