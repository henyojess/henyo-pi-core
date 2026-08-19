/**
 * Validate-then-repair engine for LLM tool-call inputs.
 *
 * Architecture (middleware-chain):
 *
 * 1. Stage 1 — Markdown auto-link unwrapping on path fields (unconditional).
 *    Auto-linked paths are valid strings, so validation can never catch them.
 *
 * 2. Stage 2 — Strict `Value.Check` (no Convert). If valid and no changes,
 *    return the original input by reference (fast path). If invalid, record
 *    the original issues for fingerprinting and retry messages.
 *
 * 3. Stage 3 — Middleware loop (up to 2 passes). Each middleware is called
 *    in order; if any changes the input, re-collect issues and loop.
 *    Notes are deduplicated by rule name.
 *
 * 4. Stage 4 — Convert coexistence. Run `Value.Convert` then `Value.Check`.
 *    If Convert alone makes it valid and no middleware fired, return original
 *    input (pi's native coercion is preserved). If Convert makes it valid
 *    and middleware fired, return the converted value as "repaired".
 *
 * 5. If still invalid after all stages → unrepairable with retry message.
 *
 * Design notes:
 * - Strict check runs BEFORE Convert because Convert silently corrupts inputs
 *   this layer exists to fix: `'["a","b"]'` becomes `['["a","b"]']`,
 *   `null` for optional string becomes `"null"`, etc.
 * - Every mutation produces a model-facing note for transparency.
 * - Fingerprint is FNV-1a hash of (tool, failure shape) for telemetry.
 */

import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type {
  MiddlewareContext,
  MiddlewareResult,
  RawIssue,
  RepairResult,
  ToolRepairConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
const PROTOCOL = /^https?:\/\//;

/** Unwrap `[text](protocol://text)` when text === url-without-protocol. */
function unwrapMarkdownAutoLinks(value: string): string {
  return value.replace(MARKDOWN_LINK, (_match, text: string, url: string) =>
    url.replace(PROTOCOL, '') === text ? text : _match,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaAccepts(schema: TSchema, value: unknown): boolean {
  return Value.Check(schema, value);
}

// ---------------------------------------------------------------------------
// Issue collection
// ---------------------------------------------------------------------------

const MAX_ISSUES = 32;

function collectErrors(schema: TSchema, value: unknown): RawIssue[] {
  const out: RawIssue[] = [];
  for (const error of Value.Errors(schema, value)) {
    out.push({
      keyword: String((error as { keyword?: string }).keyword ?? ''),
      instancePath: String((error as { instancePath?: string }).instancePath ?? ''),
      params: (error as { params?: Record<string, unknown> }).params,
      message: (error as { message?: string }).message,
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fingerprinting (FNV-1a)
// ---------------------------------------------------------------------------

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function describeIssue(issue: RawIssue): string {
  const path = issue.instancePath === '' ? '(root)' : issue.instancePath;
  const detail =
    typeof issue.params?.type === 'string'
      ? issue.params.type
      : Array.isArray(issue.params?.requiredProperties)
        ? issue.params.requiredProperties.join(',')
        : '';
  return `${path}|${issue.keyword}|${detail}`;
}

// ---------------------------------------------------------------------------
// Retry message
// ---------------------------------------------------------------------------

function buildRetryMessage(toolName: string, issues: RawIssue[], input: unknown): string {
  const lines = issues
    .slice(0, 8)
    .map(
      (issue) =>
        `  • ${issue.instancePath === '' ? '(root)' : issue.instancePath}: ${issue.message ?? issue.keyword}`,
    );
  let received: string;
  try {
    received = JSON.stringify(input) ?? String(input);
  } catch {
    received = String(input);
  }
  if (received.length > 300) received = `${received.slice(0, 300)}…`;
  return `Invalid input for tool "${toolName}". Fix these issues and retry:\n${lines.join('\n')}\nReceived: ${received}`;
}

// ---------------------------------------------------------------------------
// Engine driver
// ---------------------------------------------------------------------------

/**
 * Run the repair pipeline on a tool input.
 *
 * @param config — ToolRepairConfig with schema, middleware, and field aliases.
 * @param input — The raw tool input from the model.
 * @param toolName — Name of the tool being repaired (for notes / telemetry).
 */
export function repairToolInput(
  config: ToolRepairConfig,
  input: unknown,
  toolName: string,
): RepairResult {
  const rulesFired: string[] = [];
  const notes: string[] = [];

  const fire = (rule: string, note: string) => {
    if (!rulesFired.includes(rule)) rulesFired.push(rule);
    notes.push(note);
  };

  // ── Stage 1: Markdown auto-link unwrapping on path fields ──────────────

  let current: unknown = structuredClone(input);
  if (isPlainObject(current)) {
    for (const field of config.pathFields ?? []) {
      const value = current[field];
      if (typeof value !== 'string') continue;
      const unwrapped = unwrapMarkdownAutoLinks(value);
      if (unwrapped === value) continue;
      current[field] = unwrapped;
      fire(
        'unwrapMarkdownAutoLink',
        `Unwrapped markdown auto-link in \`${field}\` for tool "${toolName}" (\`${value}\` -> \`${unwrapped}\`). Send plain paths, not markdown links.`,
      );
    }
  }

  // ── Stage 2: Strict validation (no Convert) ────────────────────────────

  if (schemaAccepts(config.schema, current)) {
    if (rulesFired.length === 0) {
      return {
        outcome: 'valid',
        args: input,
        rulesFired,
        notes,
        issueSummary: undefined,
        fingerprint: undefined,
        retryMessage: undefined,
      };
    }
    // Path fields were unwrapped but nothing else was wrong → repaired
    return {
      outcome: 'repaired',
      args: current,
      rulesFired,
      notes,
      issueSummary: undefined,
      fingerprint: undefined,
      retryMessage: undefined,
    };
  }

  // Record original failure shape before repairs mutate it.
  const originalIssues = collectErrors(config.schema, current);
  const issueSummary = originalIssues.map(describeIssue).join('; ');
  const fingerprint = fnv1a(`${toolName}::${originalIssues.map(describeIssue).sort().join(';')}`);

  const unrepairable = (): RepairResult => ({
    outcome: 'unrepairable',
    args: input,
    rulesFired: [],
    notes: [],
    issueSummary,
    fingerprint,
    retryMessage: buildRetryMessage(toolName, originalIssues, input),
  });

  // ── Stage 3: Root string parsing ───────────────────────────────────────

  if (typeof current === 'string') {
    const trimmed = current.trim();
    const parsed =
      trimmed.startsWith('{') && trimmed.endsWith('}') ? tryParseJson(trimmed) : undefined;
    if (isPlainObject(parsed)) {
      current = parsed;
      fire(
        'parseRootString',
        `Parsed JSON-stringified arguments for tool "${toolName}". Send arguments as a JSON object next time, not a string.`,
      );
    } else if (config.fieldAliases) {
      // Root string that isn't an object — treat as a single-value wrapper
      // The first known field name becomes the key.
      const firstField = Object.keys(config.fieldAliases)[0];
      if (firstField) {
        current = { [firstField]: current };
        fire(
          'wrapRootStringAsObject',
          `Wrapped bare string as \`{${firstField}: "..." }\` for tool "${toolName}". Call with an object, not a bare string, next time.`,
        );
      }
    }
    if (isPlainObject(current)) {
      // Re-apply auto-link unwrapping after root parsing
      for (const field of config.pathFields ?? []) {
        const value = current[field];
        if (typeof value !== 'string') continue;
        const unwrapped = unwrapMarkdownAutoLinks(value);
        if (unwrapped === value) continue;
        current[field] = unwrapped;
        fire(
          'unwrapMarkdownAutoLink',
          `Unwrapped markdown auto-link in \`${field}\` for tool "${toolName}" (\`${value}\` -> \`${unwrapped}\`). Send plain paths, not markdown links.`,
        );
      }
    }
  }

  if (!isPlainObject(current)) return unrepairable();

  // ── Stage 4: Middleware loop (up to 2 passes) ──────────────────────────

  const ctx: MiddlewareContext = {
    toolName,
    schema: config.schema,
    issues: originalIssues,
  };

  for (let pass = 0; pass < 2; pass++) {
    let changedThisPass = false;
    for (const mw of config.middleware) {
      const result = mw(current as Record<string, unknown>, ctx);
      if (result.changed) {
        changedThisPass = true;
        // Extract rule name from note (first sentence / key phrase)
        const ruleName = result.note.split(' for tool')[0].trim();
        fire(ruleName, result.note);
      }
    }
    if (!changedThisPass) break;
  }

  // ── Stage 5: Convert coexistence ───────────────────────────────────────

  const probe = Value.Convert(config.schema, structuredClone(current));
  if (schemaAccepts(config.schema, probe)) {
    if (rulesFired.length === 0) {
      // Convert alone fixes it — defer to pi's native coercion.
      return {
        outcome: 'valid',
        args: input,
        rulesFired,
        notes,
        issueSummary: undefined,
        fingerprint: undefined,
        retryMessage: undefined,
      };
    }
    return {
      outcome: 'repaired',
      args: probe,
      rulesFired,
      notes,
      issueSummary,
      fingerprint,
      retryMessage: undefined,
    };
  }

  return unrepairable();
}

/**
 * Parse a JSON string, returning the parsed value or undefined on failure.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
