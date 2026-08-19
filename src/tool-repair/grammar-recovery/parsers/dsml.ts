/** DSML grammar-family parser. */

import type { Candidate, Range } from '../types.js';
import {
  extractFirstBalancedJson,
  findMatching,
  findPattern,
  isInsideCodeFence,
  maybeParseJsonValue,
  normalizeArgumentsObject,
  parseJsonObject,
  parseJsonValueOrString,
} from '../utils.js';

function parseDsml(text: string): Candidate[] {
  const candidates: Candidate[] = [];

  const prefix = '(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)';
  const outerOpen = new RegExp(`<${prefix}(?:tool_calls|function_calls)>`, 'giu');

  for (const match of text.matchAll(outerOpen)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index)) continue;
    const start = match.index;
    const bodyStart = start + match[0].length;
    const close =
      findDsmlClose(text, bodyStart, 'tool_calls') ??
      findDsmlClose(text, bodyStart, 'function_calls');
    const end = close ? close.end : findBestUnclosedDsmlEnd(text, bodyStart);
    if (end === undefined) continue;
    const body = text.slice(bodyStart, close ? close.start : end);
    const calls = parseDsmlInvokes(body);
    for (const call of calls) {
      candidates.push({ ...call, grammar: 'dsml', range: { start, end } });
    }
  }

  return candidates;
}

function parseDsmlDanglingMarkers(text: string): Candidate[] {
  if (!text.includes('DSML')) return [];
  const prefix = '(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)';
  const markerRe = new RegExp(
    `</?${prefix}(?:tool_calls|function_calls|invoke|parameter)(?:\\s+[^>\\n]*)?>?`,
    'giu',
  );
  const candidates: Candidate[] = [];
  for (const match of text.matchAll(markerRe)) {
    if (match.index === undefined) continue;
    if (isInsideCodeFence(text, match.index)) continue;
    candidates.push({
      name: '',
      arguments: {},
      grammar: 'dsml',
      range: { start: match.index, end: match.index + match[0].length },
      stripOnly: true,
    });
  }
  return candidates;
}

function findDsmlClose(text: string, from: number, outerName: string): Range | undefined {
  const prefix = '(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)';
  const closeRe = new RegExp(`</${prefix}${outerName}>`, 'giu');
  closeRe.lastIndex = from;
  const match = closeRe.exec(text);
  return match && match.index >= from
    ? { start: match.index, end: match.index + match[0].length }
    : undefined;
}

function findBestUnclosedDsmlEnd(text: string, from: number): number | undefined {
  const invokeClose = /<\/(?:｜{1,2}DSML｜{1,2}|DSML｜|\s*\|\s*DSML\s*\|\s*)invoke>/giu;
  invokeClose.lastIndex = from;
  let end: number | undefined;
  for (;;) {
    const match = invokeClose.exec(text);
    if (!match) break;
    end = match.index + match[0].length;
  }
  return end;
}

function parseDsmlInvokes(body: string): Array<Omit<Candidate, 'range' | 'grammar'>> {
  const calls: Array<Omit<Candidate, 'range' | 'grammar'>> = [];
  const prefix = '(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)';
  const invokeRe = new RegExp(`<${prefix}invoke\\s+name=["']([^"']+)["']\\s*>`, 'giu');

  for (const match of body.matchAll(invokeRe)) {
    if (match.index === undefined) continue;
    const name = match[1]?.trim();
    if (!name) continue;
    const invokeBodyStart = match.index + match[0].length;
    const close = findPattern(body, new RegExp(`</${prefix}invoke>`, 'iu'), invokeBodyStart);
    if (!close) continue;
    const invokeBody = body.slice(invokeBodyStart, close.start);
    calls.push({ name, arguments: parseDsmlArguments(invokeBody) });
  }

  return calls;
}

function parseDsmlArguments(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const prefix = '(?:｜{1,2}DSML｜{1,2}|DSML｜|\\s*\\|\\s*DSML\\s*\\|\\s*)';
  const paramRe = new RegExp(
    `<${prefix}parameter\\s+name=["']([^"']+)["'](?:\\s+string=["'](true|false)["'])?\\s*>([\\s\\S]*?)</${prefix}parameter>`,
    'giu',
  );

  for (const match of body.matchAll(paramRe)) {
    const key = match[1]?.trim();
    if (!key) continue;
    const stringAttr = match[2];
    const rawValue = match[3] ?? '';
    args[key] = stringAttr === 'false' ? parseJsonValueOrString(rawValue.trim()) : rawValue;
  }

  if (Object.keys(args).length > 0) return args;

  const direct = parseJsonObject(extractFirstBalancedJson(body.trim())?.json ?? body.trim());
  return normalizeArgumentsObject(direct) ?? {};
}

export { parseDsml, parseDsmlDanglingMarkers };
