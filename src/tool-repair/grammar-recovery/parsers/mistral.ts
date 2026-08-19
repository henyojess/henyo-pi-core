/** Mistral grammar-family parser. */

import type { Candidate } from '../types.js';
import {
  callFromJsonObject,
  extractFirstBalancedJson,
  isInsideCodeFence,
  normalizeArgumentsObject,
  parseJsonArrayObjects,
  parseJsonObject,
} from '../utils.js';

function parseMistral(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const marker = '[TOOL_CALLS]';
  let index = 0;

  for (index = text.indexOf(marker, index); index !== -1; index = text.indexOf(marker, index)) {
    if (isInsideCodeFence(text, index)) {
      index += marker.length;
      continue;
    }

    const afterMarker = index + marker.length;
    const rest = text.slice(afterMarker).trimStart();
    const whitespace = text.slice(afterMarker).length - rest.length;
    const jsonStart = afterMarker + whitespace;

    if (rest.startsWith('[')) {
      const extracted = extractFirstBalancedJson(text.slice(jsonStart));
      if (extracted?.json.startsWith('[')) {
        for (const item of parseJsonArrayObjects(extracted.json)) {
          const call = callFromJsonObject(item);
          if (call) {
            candidates.push({
              ...call,
              grammar: 'mistral',
              range: { start: index, end: jsonStart + extracted.end },
            });
          }
        }
        index = jsonStart + extracted.end;
        continue;
      }
    }

    const v11 = /^([A-Za-z_][\w.-]*)\[CALL_ID\]([^[]*)\[ARGS\]/.exec(rest);
    if (v11) {
      const name = v11[1];
      const argsStart = jsonStart + v11[0].length;
      const extracted = extractFirstBalancedJson(text.slice(argsStart));
      if (extracted) {
        candidates.push({
          name,
          arguments: normalizeArgumentsObject(parseJsonObject(extracted.json)) ?? {},
          grammar: 'mistral',
          range: { start: index, end: argsStart + extracted.end },
        });
        index = argsStart + extracted.end;
        continue;
      }
    }

    index += marker.length;
  }

  return candidates;
}

export { parseMistral };
