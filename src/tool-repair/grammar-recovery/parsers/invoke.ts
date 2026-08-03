/** Invoke XML grammar-family parser. */

import type { Candidate } from "../types.js";
import {
  isInsideCodeFence,
  maybeParseJsonValue,
  normalizeArgumentsObject,
  parseJsonObject,
  parseJsonValueOrString,
} from "../utils.js";

function parseInvokeXml(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const wrappedRe =
    /<(?:[A-Za-z][\w.-]*:)?tool_call>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?tool_call>/gi;

  for (const wrapper of text.matchAll(wrappedRe)) {
    if (wrapper.index === undefined || isInsideCodeFence(text, wrapper.index))
      continue;
    const calls = parseInvokeBody(wrapper[1] ?? "");
    for (const call of calls) {
      candidates.push({
        ...call,
        grammar: "invoke",
        range: { start: wrapper.index, end: wrapper.index + wrapper[0].length },
      });
    }
  }

  const standaloneRe =
    /<invoke\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/invoke>/gi;
  for (const match of text.matchAll(standaloneRe)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const calls = parseInvokeBody(match[0]);
    for (const call of calls) {
      candidates.push({
        ...call,
        grammar: "invoke",
        range: { start: match.index, end: match.index + match[0].length },
      });
    }
  }

  candidates.push(...parseMalformedMiniMaxInvoke(text));
  return candidates;
}

function parseInvokeBody(
  body: string,
): Array<Omit<Candidate, "range" | "grammar">> {
  const calls: Array<Omit<Candidate, "range" | "grammar">> = [];
  const invokeRe = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;

  for (const match of body.matchAll(invokeRe)) {
    const name = match[1]?.trim();
    if (!name) continue;
    calls.push({ name, arguments: parseInvokeArguments(match[2] ?? "") });
  }

  return calls;
}

function parseInvokeArguments(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const paramRe =
    /<parameter\s+name=["']([^"']+)["'](?:\s+string=["'](true|false)["'])?\s*>([\s\S]*?)<\/parameter>/gi;

  for (const match of body.matchAll(paramRe)) {
    const key = match[1]?.trim();
    if (!key) continue;
    const raw = match[3] ?? "";
    args[key] =
      match[2] === "false"
        ? parseJsonValueOrString(raw.trim())
        : maybeParseJsonValue(raw.trim());
  }

  if (Object.keys(args).length > 0) return args;
  return normalizeArgumentsObject(parseJsonObject(body.trim())) ?? {};
}

function parseMalformedMiniMaxInvoke(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const re =
    /(?:^|\n)(\s*)invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)(?:\n\s*(?:\/invoke|invoke)>|$)/gi;

  for (const match of text.matchAll(re)) {
    if (match.index === undefined || isInsideCodeFence(text, match.index))
      continue;
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const name = match[2]?.trim();
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const paramRe =
      /parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)\s*parameter>/gi;
    for (const param of (match[3] ?? "").matchAll(paramRe)) {
      const key = param[1]?.trim();
      if (key) args[key] = maybeParseJsonValue((param[2] ?? "").trim());
    }
    candidates.push({
      name,
      arguments: args,
      grammar: "invoke",
      range: { start, end: match.index + match[0].length },
    });
  }

  return candidates;
}

export { parseInvokeXml, parseInvokeBody, parseInvokeArguments };
