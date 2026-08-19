/** Qwen / GLM / Granite XML grammar-family parser. */

import type { Candidate, GrammarName } from '../types.js';
import {
  callFromJsonObject,
  extractFirstBalancedJson,
  isInsideCodeFence,
  isObject,
  maybeParseJsonValue,
  parseJsonValue,
  unwrapMarkdownFence,
} from '../utils.js';

function parseToolCallXml(text: string, enabled: Set<GrammarName>): Candidate[] {
  const candidates: Candidate[] = [];
  const wrapperRe = /<(tool_call|tools)>[\s\S]*?<\/\1>/gi;

  for (const match of text.matchAll(wrapperRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index)) continue;
    const tag = match[1]?.toLowerCase();
    const openTagEnd = match[0].indexOf('>') + 1;
    const body = match[0].slice(openTagEnd, match[0].length - `</${tag}>`.length);

    if (enabled.has('granite') || enabled.has('qwen')) {
      const jsonGrammar = tag === 'tools' || !enabled.has('granite') ? 'qwen' : 'granite';
      const jsonCalls = parseToolCallJsonBody(body, jsonGrammar);
      for (const call of jsonCalls) {
        candidates.push({
          ...call,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    if (enabled.has('glm')) {
      const glmCall = parseGlmToolCallBody(body);
      if (glmCall)
        candidates.push({
          ...glmCall,
          range: { start: match.index, end: match.index + match[0].length },
        });
    }

    if (enabled.has('qwen')) {
      const qwenCalls = parseQwenFunctionBody(body);
      for (const call of qwenCalls) {
        candidates.push({
          ...call,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }
  }

  if (enabled.has('qwen')) {
    const bareFunctionRe = /<function=([A-Za-z_][\w.-]*)>[\s\S]*?<\/function>/gi;
    for (const match of text.matchAll(bareFunctionRe)) {
      if (match.index === undefined || isInsideCodeFence(text, match.index)) continue;
      const calls = parseQwenFunctionBody(match[0]);
      for (const call of calls) {
        candidates.push({
          ...call,
          range: { start: match.index, end: match.index + match[0].length },
        });
      }
    }
  }

  return candidates;
}

function parseToolCallJsonBody(
  body: string,
  grammar: GrammarName,
): Array<Omit<Candidate, 'range'>> {
  const calls: Array<Omit<Candidate, 'range'>> = [];
  const trimmed = unwrapMarkdownFence(body.trim());
  const json = extractFirstBalancedJson(trimmed)?.json ?? trimmed;
  const parsed = parseJsonValue(json);

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (isObject(item)) {
        const call = callFromJsonObject(item);
        if (call) calls.push({ ...call, grammar });
      }
    }
    return calls;
  }

  if (isObject(parsed)) {
    const call = callFromJsonObject(parsed);
    if (call) calls.push({ ...call, grammar });
  }

  return calls;
}

function parseQwenFunctionBody(body: string): Array<Omit<Candidate, 'range'>> {
  const calls: Array<Omit<Candidate, 'range'>> = [];
  const functionRe = /<function=([A-Za-z_][\w.-]*)>\s*([\s\S]*?)<\/function>/gi;

  for (const match of body.matchAll(functionRe)) {
    const name = match[1]?.trim();
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
    for (const param of (match[2] ?? '').matchAll(paramRe)) {
      const key = param[1]?.trim();
      if (!key) continue;
      args[key] = maybeParseJsonValue((param[2] ?? '').trim());
    }
    calls.push({ name, arguments: args, grammar: 'qwen' });
  }

  return calls;
}

function parseGlmToolCallBody(body: string): Omit<Candidate, 'range'> | undefined {
  const keyRe = /<arg_key>([\s\S]*?)<\/arg_key>/gi;
  const valueRe = /<arg_value>([\s\S]*?)<\/arg_value>/gi;
  const keys = [...body.matchAll(keyRe)].map((m) => (m[1] ?? '').trim()).filter(Boolean);
  const values = [...body.matchAll(valueRe)].map((m) => (m[1] ?? '').trim());
  const nameEnd = keys.length === 0 ? body.length : body.search(/<arg_key>/i);
  const name = body.slice(0, nameEnd).trim().split(/\s+/)[0];
  if (!name || !/^[A-Za-z_][\w.-]*$/.test(name)) return undefined;

  const args: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    args[key] = maybeParseJsonValue(values[i] ?? '');
  });
  return { name, arguments: args, grammar: 'glm' };
}

export { parseToolCallXml, parseToolCallJsonBody, parseQwenFunctionBody, parseGlmToolCallBody };
