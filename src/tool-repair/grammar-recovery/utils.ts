/**
 * Shared utilities for grammar-leak recovery.
 *
 * Used by both parser files and the engine. Functions are internal to the
 * grammar-recovery module — not exported from the public index.
 */

import type {
  Candidate,
  GrammarName,
  MinimalAssistantContent,
  Range,
} from "./types.js";
import { RecoveredToolCall } from "./types.js";

// ─── Candidate selection ──────────────────────────────────────────────────────

function selectCandidates(candidates: Candidate[]): Candidate[] {
  const selected: Candidate[] = [];
  const sorted = [...candidates].sort((a, b) => {
    if (a.range.start !== b.range.start) return a.range.start - b.range.start;
    return b.range.end - b.range.start - (a.range.end - a.range.start);
  });

  for (const candidate of sorted) {
    const duplicate = selected.some((existing) => {
      const sameRange =
        existing.range.start === candidate.range.start &&
        existing.range.end === candidate.range.end;
      return !sameRange && rangesOverlap(existing.range, candidate.range);
    });
    if (!duplicate) selected.push(candidate);
  }

  return selected;
}

function rangesOverlap(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

function isAllowedTool(
  candidateName: string,
  requireKnownTool: boolean,
  knownTools: Set<string>,
): boolean {
  if (!requireKnownTool) return true;
  return knownTools.size > 0 && knownTools.has(candidateName);
}

// ─── Text range manipulation ──────────────────────────────────────────────────

function removeRanges(text: string, ranges: Range[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const range of sorted) {
    result += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  result += text.slice(cursor);
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Content part helpers ─────────────────────────────────────────────────────

function getPartText(part: MinimalAssistantContent): string | undefined {
  if (isObject(part) && part.type === "text" && typeof part.text === "string")
    return part.text;
  if (
    isObject(part) &&
    part.type === "thinking" &&
    typeof part.thinking === "string"
  )
    return part.thinking;
  return undefined;
}

function setPartText(
  part: MinimalAssistantContent,
  text: string,
): MinimalAssistantContent {
  if (isObject(part) && part.type === "text") return { ...part, text };
  if (isObject(part) && part.type === "thinking")
    return { ...part, thinking: text };
  return part;
}

function isToolCallContent(
  part: MinimalAssistantContent,
): part is MinimalAssistantContent & { type: "toolCall"; name: string } {
  return (
    isObject(part) && part.type === "toolCall" && typeof part.name === "string"
  );
}

function makeRecoveredToolCallId(grammar: GrammarName, index: number): string {
  return `tool_repair_${grammar.replace(/[^a-z0-9]/gi, "_")}_${Date.now().toString(36)}_${index}`;
}

// ─── Pattern finding ──────────────────────────────────────────────────────────

function findPattern(
  text: string,
  pattern: RegExp,
  from: number,
): Range | undefined {
  pattern.lastIndex = 0;
  const chunk = text.slice(from);
  const match = pattern.exec(chunk);
  return match
    ? { start: from + match.index, end: from + match.index + match[0].length }
    : undefined;
}

function extractFirstBalancedJson(
  text: string,
): { json: string; start: number; end: number } | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  const end = findMatching(text, start, opener, closer);
  if (end === undefined) return undefined;
  return { json: text.slice(start, end + 1), start, end: end + 1 };
}

function findMatching(
  text: string,
  openIndex: number,
  opener: string,
  closer: string,
): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === opener) depth++;
    if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return undefined;
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === delimiter && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function findTopLevelChar(text: string, target: string): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === target && depth === 0) return i;
  }

  return -1;
}

function findLineEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline;
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

function parseJsonValue(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function parseJsonObject(json: string): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(json);
  return isObject(parsed) ? parsed : undefined;
}

function parseJsonArrayObjects(json: string): Record<string, unknown>[] {
  const parsed = parseJsonValue(json);
  return Array.isArray(parsed) ? parsed.filter(isObject) : [];
}

function parseJsonValueOrString(value: string): unknown {
  const parsed = parseJsonValue(value);
  return parsed === undefined ? value : parsed;
}

function maybeParseJsonValue(value: string): unknown {
  if (value === "") return "";
  if (/^(?:true|false|null|-?\d|[[{]|")/.test(value)) {
    return parseJsonValueOrString(value);
  }
  return value;
}

// ─── Call extraction from JSON values ─────────────────────────────────────────

function callsFromJsonValue(
  value: unknown,
): Array<Omit<Candidate, "range" | "grammar">> {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      isObject(item) ? callsFromJsonValue(item) : [],
    );
  }
  if (!isObject(value)) return [];
  const call = callFromJsonObject(value);
  return call ? [call] : [];
}

function callFromJsonObject(
  value: Record<string, unknown>,
): Omit<Candidate, "range" | "grammar"> | undefined {
  const name =
    value.name ??
    value.function_name ??
    (isObject(value.function) ? value.function.name : undefined);
  if (typeof name !== "string" || !name.trim()) return undefined;

  let args: unknown = value.arguments ?? value.args ?? value.parameters;
  if (args === undefined && isObject(value.function))
    args = value.function.arguments;
  const normalized = normalizeArgumentsObject(args) ?? {};
  return { name: name.trim(), arguments: normalized };
}

function normalizeArgumentsObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    return normalizeArgumentsObject(parseJsonValue(value));
  }
  if (isObject(value)) {
    const nested = value.arguments;
    if (typeof nested === "string" || isObject(nested)) {
      const unwrapped = normalizeArgumentsObject(nested);
      if (unwrapped) return unwrapped;
    }
    return value;
  }
  return undefined;
}

// ─── Code fence awareness ─────────────────────────────────────────────────────

function isInsideCodeFence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const fences = before.match(/```/g);
  return Boolean(fences && fences.length % 2 === 1);
}

function unwrapMarkdownFence(text: string): string {
  const match = /^```\w*\s*([\s\S]*?)\s*```$/.exec(text);
  return match ? (match[1] ?? "") : text;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ─── Pythonic call parsing (shared by olmo, llama, granite) ──────────────────

function parsePythonicCalls(
  text: string,
): Array<Omit<Candidate, "range" | "grammar">> {
  const calls: Array<Omit<Candidate, "range" | "grammar">> = [];
  const re = /(?:^|\n)\s*([A-Za-z_][\w.-]*)\s*\(/g;
  for (const match of text.matchAll(re)) {
    if (match.index === undefined) continue;
    const name = match[1];
    const openParen = match.index + match[0].lastIndexOf("(");
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen === undefined) continue;
    const argsText = text.slice(openParen + 1, closeParen);
    calls.push({ name, arguments: parseKeywordArguments(argsText) });
  }
  return calls;
}

function parseKeywordArguments(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitTopLevel(text, ",")) {
    const eq = findTopLevelChar(part, "=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(key)) continue;
    args[key] = parsePythonishValue(part.slice(eq + 1).trim());
  }
  return args;
}

function parsePythonishValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "True") return true;
  if (trimmed === "False") return false;
  if (trimmed === "None") return null;
  if (/^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  return parseJsonValueOrString(
    trimmed
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null"),
  );
}

// ─── Exports (internal module use only) ───────────────────────────────────────

export {
  selectCandidates,
  rangesOverlap,
  isAllowedTool,
  removeRanges,
  getPartText,
  setPartText,
  isToolCallContent,
  makeRecoveredToolCallId,
  isInsideCodeFence,
  unwrapMarkdownFence,
  isObject,
  findPattern,
  extractFirstBalancedJson,
  findMatching,
  splitTopLevel,
  findTopLevelChar,
  findLineEnd,
  parseJsonValue,
  parseJsonObject,
  parseJsonArrayObjects,
  parseJsonValueOrString,
  maybeParseJsonValue,
  callsFromJsonValue,
  callFromJsonObject,
  normalizeArgumentsObject,
  parsePythonicCalls,
  parseKeywordArguments,
  parsePythonishValue,
};
