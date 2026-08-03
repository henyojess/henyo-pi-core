/** MiniMax grammar-family parser. */

import type { Candidate } from "../types.js";
import {
  findMatching,
  isInsideCodeFence,
  normalizeArgumentsObject,
  parseJsonObject,
} from "../utils.js";

function parseMiniMaxText01(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const re = /<function_call>[\s\S]*?functions\.([A-Za-z_][\w.-]*)\s*\(/gi;

  for (const match of text.matchAll(re)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const name = match[1];
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen === undefined) continue;
    const rawArgs = text.slice(openParen + 1, closeParen).trim();
    const args = normalizeArgumentsObject(parseJsonObject(rawArgs)) ?? {};
    const fenceEnd = text.indexOf("```", closeParen);
    const end = fenceEnd === -1 ? closeParen + 1 : fenceEnd + 3;
    candidates.push({
      name,
      arguments: args,
      grammar: "minimax-text",
      range: { start: match.index, end },
    });
  }

  return candidates;
}

export { parseMiniMaxText01 };
