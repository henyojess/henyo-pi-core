/**
 * Standalone tool repair — event hooks only, no tool overrides.
 *
 * What it fixes: some models (observed: Qwen 3.6 "dumb-zone" runs, Jul 26–Aug
 * 22 2026) emit broken `edit` arguments — `path` nested inside `edits[0]`
 * instead of at the top level (validation fails with "required: path"), or
 * the whole `edits` array stringified as JSON (validation fails with
 * "expected array"). It also coaches on validation failures of ANY tool
 * (both pi error signatures) and on hallucinated tool names. Provenance:
 * 60 repaired vs 56 unrepairable telemetry events; stringified `edits` was
 * the dominant unhandled shape (13 old-telemetry + 4 post-deploy + 11
 * `Invalid input` era).
 *
 * Three hooks:
 * 1. `message_end` (repair) — for `edit` calls, before execution: parse a
 *    stringified `edits` back into an array (rule `parse-stringified-edits`),
 *    then hoist `edits[0].path` to top-level `path` (rule `extract-path`),
 *    then salvage `edits` strings corrupt beyond strict parse
 *    (`salvage-corrupt-edits`), recover garbled `path>` keys
 *    (`recover-garbled-path`), and drop incomplete entries
 *    (`drop-incomplete-edits`); one `fixed` log record carries the full
 *    rules array. When `opts.editFallbackEnabled` is true, a further stage
 *    runs after the shape rules: whitespace-drifted `edits[].oldText` whose
 *    normalized form matches the file uniquely 1:1 is rewritten to the
 *    file's exact bytes (rule `whitespace-normalize-oldtext`) so the
 *    built-in's exact match succeeds — matching/reporting logic lives in
 *    the pure `edit-fallback.ts`. Side effect: the assistant message is
 *    rewritten in place, so session history shows the corrected shape and
 *    rewritten oldText, not the raw mistake.
 * 2. `tool_result` (coaching) — on any tool's validation failure (both
 *    signatures: `Validation failed for tool "X"` and the older
 *    `Invalid input for tool "X"`), append a one-line hint to the error the
 *    model sees — `edit` gets the specific line, other tools a generic
 *    schema hint. On `Tool X not found`, append the available tool names
 *    from `getActiveTools()` (hallucinated names are coached, never
 *    remapped). On `edit` content-mismatch errors (not-found / not-unique /
 *    overlap / identical), append a targeted one-line hint — the dominant
 *    failure class for the served Qwen models (77% of observed edit
 *    errors) — which, when `opts.editFallbackEnabled` is true, is upgraded
 *    to the full nearest-match candidate report (not-found) or the
 *    occurrence line-number list (not-unique); successful calls that used a
 *    rewritten `oldText` log an `applied` record (rewrite→result
 *    correlation via a bounded in-memory toolCallId map).
 * 3. `before_agent_start` (prevention) — append four guideline lines to the
 *    system prompt (path shape + read-before-edit + trust a reported success
 *    over transcript-echo display artifacts + edit existing files only via
 *    the `edit` tool) so models emit the correct shape and fresh `oldText`
 *    in the first place; each line is deduped independently.
 *
 * Telemetry: `~/.pi/agent/tool-repair.jsonl` (JSONL; v2 outcome set:
 * `fixed`, `ok` — denominator for every successful `edit`, `applied`,
 * `recovered` — a previously failed edit on the same file succeeded
 * (carries the original failure's `fingerprint`/`issues` plus
 * `recoveredBy` and `afterMs`), and `failed`; non-`edit` successes are
 * not logged). Validation-class `failed` records may carry `emission`
 * (`truncated`/`glued`/`shape-quirk`); `failed` `edit` records may carry
 * `retriedVerbatim` (a same-fingerprint failure is open for the file with
 * no successful `read` of it in between). Fingerprint: `edit` events use the
 * location fingerprint (`fnv1a("edit::loc::<basename>::<normalized
 * oldText prefix>")` — an irreversible hash; argument values are never
 * logged); non-edit events keep `fnv1a("<tool>::<sorted keys>")` (shape
 * only; historical edit fingerprints are non-comparable across v2).
 *
 * Because no tools are registered or overridden, this coexists with any
 * repair layer that wraps `prepareArguments`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  COACHING_LINE,
  CONTENT_ERROR_RULES,
  FALLBACK_TOOL_LIST,
  GENERIC_COACHING_LINE,
  NO_BYPASS_LINE,
  PROMPT_LINE,
  READ_BEFORE_EDIT_LINE,
  TRUST_RESULT_LINE,
  UNKNOWN_TOOL_SIGNATURE,
} from './coach.js';
import {
  classifyEmission,
  editLocationFingerprint,
  shapeDiagnostics,
  shapeFingerprint,
} from './fingerprint.js';
import {
  applyEditFallback,
  classifyContentError,
  OPEN_FAILURES_CAP,
  type LogRecord,
  type OpenFailure,
  type PendingRewrite,
} from './telemetry.js';
import {
  dropIncompleteEdits,
  hoistEditPath,
  recoverGarbledPath,
  repairStringifiedEdits,
  salvageCorruptEdits,
} from './rules.js';

/** Settings resolution: `toolRepair` default on (absent key = enabled). */
export function resolveToolRepair(s: { toolRepair?: boolean }): boolean {
  return s.toolRepair ?? true;
}

/** Settings resolution: `editFallback` default on (absent key = enabled). */
export function resolveEditFallback(s: { editFallback?: boolean }): boolean {
  return s.editFallback ?? true;
}

/**
 * Register the three hooks. `opts.enabled` gates all three at runtime so the
 * extension can be registered unconditionally; `opts.logPath` overrides the
 * default `~/.pi/agent/tool-repair.jsonl` (used by tests).
 * `opts.editFallbackEnabled` (strict: only `true` activates) gates the
 * fuzzy/nearest-match edit fallback (whitespace-drift `oldText` rewrite on
 * `message_end`, candidate/duplicate coaching on `tool_result`) — off by
 * default here so callers that don't know about it keep today's behavior
 * byte-identical; `src/index.ts` plumbs the `henyo.editFallback` setting.
 * The `message_end` and `tool_result` handlers are async (file reads via
 * `node:fs/promises`; `ExtensionHandler` accepts `Promise<R | void>`).
 */
export function toolRepairExtension(
  pi: ExtensionAPI,
  opts: { enabled: boolean; logPath?: string; editFallbackEnabled?: boolean },
): void {
  const appendLog = (record: LogRecord): void => {
    try {
      const file = opts.logPath ?? join(getAgentDir(), 'tool-repair.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + '\n');
    } catch {
      // Telemetry must never break a run.
    }
  };

  // toolCallId → per-edit rewrite records (cap PENDING_REWRITE_CAP, FIFO).
  const pendingRewrites = new Map<string, PendingRewrite[]>();

  // Telemetry v2 recovery state (plan A2/A5): open edit failures per file
  // key (basename of the top-level `path`), in-memory only — "same session"
  // is the intended semantics. Per-file FIFO cap OPEN_FAILURES_CAP.
  const openFailures = new Map<string, OpenFailure[]>();

  // Telemetry v2 (assumption 6): last successful `read` timestamp per file
  // key. A read resets `retriedVerbatim` — the model then holds fresh
  // content, so a later same-fingerprint failure is not a blind verbatim
  // retry. Reads intentionally do NOT call `recoverFailures` (a read is not
  // recovery of the failed edit; logging `recovered` with a read's
  // toolCallId would mislabel the record).
  const lastReadTs = new Map<string, string>();

  /** fileKey for an edit input — basename of a string top-level `path`; `undefined` (no tracking) otherwise. */
  const editFileKey = (input: unknown): string | undefined => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const path = (input as Record<string, unknown>).path;
    return typeof path === 'string' ? basename(path) : undefined;
  };

  /** Push an open failure for a file; FIFO drop the oldest past the cap. */
  const rememberOpenFailure = (fileKey: string, entry: OpenFailure): void => {
    const list = openFailures.get(fileKey) ?? [];
    list.push(entry);
    while (list.length > OPEN_FAILURES_CAP) list.shift();
    openFailures.set(fileKey, list);
  };

  /**
   * Pop ALL open failures for a file and log one `recovered` record per
   * entry (carrying the ORIGINAL failure's fingerprint, issues, ts; plan
   * A2 — per-file coarseness). Called from both the ok site and the
   * applied success path; the ok site runs first, so the applied-site
   * call is a no-op in practice.
   */
  const recoverFailures = (fileKey: string, byToolCallId: string, nowTs: string): void => {
    const list = openFailures.get(fileKey);
    if (list === undefined || list.length === 0) return;
    openFailures.delete(fileKey);
    lastReadTs.delete(fileKey); // bookkeeping: fresh tracking after recovery
    for (const entry of list) {
      appendLog({
        ts: nowTs,
        tool: 'edit',
        model: entry.model,
        outcome: 'recovered',
        fingerprint: entry.fingerprint,
        issues: entry.issues,
        toolCallId: entry.toolCallId,
        recoveredBy: byToolCallId,
        afterMs: Date.now() - new Date(entry.ts).getTime(),
      });
    }
  };

  // Hook 1 (O1): repair — hoist nested `path` before execution; when
  // `editFallbackEnabled`, also rewrite whitespace-drifted `oldText` to the
  // file's exact bytes (rule `whitespace-normalize-oldtext`) so the
  // built-in's exact match succeeds. Async (file reads via node:fs/promises).
  pi.on('message_end', async (event, ctx) => {
    if (!opts.enabled) return undefined;
    const message = event.message;
    if (message.role !== 'assistant') return undefined;
    const content = message.content;
    if (!Array.isArray(content)) return undefined;

    let changed = false;
    const newContent = await Promise.all(
      content.map(async (entry) => {
        if (
          entry.type !== 'toolCall' ||
          entry.name !== 'edit' ||
          entry.arguments === null ||
          typeof entry.arguments !== 'object' ||
          Array.isArray(entry.arguments)
        ) {
          return entry;
        }
        const args = entry.arguments as Record<string, unknown>;
        const rules: string[] = [];
        if (repairStringifiedEdits(args)) rules.push('parse-stringified-edits');
        if (hoistEditPath(args)) rules.push('extract-path');
        if (salvageCorruptEdits(args)) rules.push('salvage-corrupt-edits');
        if (recoverGarbledPath(args)) rules.push('recover-garbled-path');
        if (dropIncompleteEdits(args)) rules.push('drop-incomplete-edits');
        // Fuzzy-edit fallback (AFTER the shape rules — normalize needs the
        // final shape): rewrite whitespace-drifted oldText entries in place.
        const rewrites = opts.editFallbackEnabled
          ? await applyEditFallback(
              args,
              entry.id,
              ctx.cwd,
              ctx.model?.id,
              pendingRewrites,
              appendLog,
            )
          : 0;
        if (rules.length > 0 || rewrites > 0) {
          changed = true;
          if (rules.length > 0) {
            appendLog({
              ts: new Date().toISOString(),
              tool: 'edit',
              model: ctx.model?.id,
              outcome: 'fixed',
              rules,
              fingerprint: editLocationFingerprint(args) ?? shapeFingerprint('edit', args),
            });
          }
          return { ...entry, arguments: args };
        }
        return entry;
      }),
    );

    if (!changed) return undefined;
    return { message: { ...message, content: newContent } };
  });

  // Hook 2 (O3): coaching — (a) unknown-tool errors get the available tool
  // list (never remapped — plan assumption 6); (b) validation failures on
  // any tool, both pi error signatures (`Validation failed for tool "X"`
  // and the older `Invalid input for tool "X"`) get a schema hint. edit gets
  // the specific line; every other tool gets the generic one.
  pi.on('tool_result', async (event, ctx) => {
    if (!opts.enabled) return undefined;

    // Telemetry v2 denominator: every successful `edit` result logs exactly
    // one `ok` record (repaired by message_end or not — the denominator is
    // all successful edits), so error rates are computable from the log
    // alone. Edit-only by plan assumption A1.
    if (event.toolName === 'edit' && !event.isError) {
      const ts = new Date().toISOString();
      appendLog({
        ts,
        tool: 'edit',
        model: ctx.model?.id,
        outcome: 'ok',
        fingerprint: editLocationFingerprint(event.input) ?? shapeFingerprint('edit', event.input),
      });
      // Telemetry v2: close any open failures on this file (plan A2).
      const fileKey = editFileKey(event.input);
      if (fileKey !== undefined) {
        recoverFailures(fileKey, event.toolCallId, ts);
      }
    }

    // Telemetry v2 (assumption 6, plan tool-repair-edit-usage-improvements):
    // a successful `read` resets `retriedVerbatim` for that file — the model
    // then holds fresh content, so a later same-fingerprint failure is not a
    // blind verbatim retry. A read must NOT call `recoverFailures`: it is not
    // recovery of the failed edit, and logging `recovered` with a read's
    // toolCallId would mislabel the record.
    if (event.toolName === 'read' && !event.isError) {
      const fileKey = editFileKey(event.input);
      if (fileKey !== undefined) {
        lastReadTs.set(fileKey, new Date().toISOString());
      }
    }

    // Fuzzy-edit fallback correlation (plan step 3.2): a successful result
    // consumes the pending rewrite records and logs `applied`; a failed call
    // consumes them WITHOUT logging (the built-in apply is atomic — first
    // failing edit throws before any write, so no partial state) and falls
    // through to the coaching below, which may be upgraded to the full
    // candidate/duplicate report.
    if (opts.editFallbackEnabled && event.toolName === 'edit') {
      const pending = pendingRewrites.get(event.toolCallId);
      if (pending) {
        pendingRewrites.delete(event.toolCallId);
        if (!event.isError) {
          const timestamp = new Date().toISOString();
          const fingerprint =
            editLocationFingerprint(event.input) ?? shapeFingerprint('edit', event.input);
          for (const p of pending) {
            appendLog({
              ts: timestamp,
              tool: 'edit',
              model: ctx.model?.id,
              outcome: 'applied',
              rules: ['whitespace-normalize-oldtext'],
              fingerprint,
              toolCallId: event.toolCallId,
              editIndex: p.editIndex,
              lineRange: p.lineRange,
              fileLines: p.fileLines,
              oldTextLines: p.oldTextLines,
              sha12: p.sha12,
            });
          }
          // Telemetry v2: recovery is already closed by the ok site above
          // (which runs first) — called here too per plan spec; no-op.
          const fileKey = editFileKey(event.input);
          if (fileKey !== undefined) {
            recoverFailures(fileKey, event.toolCallId, timestamp);
          }
          return undefined; // success — the result content is untouched
        }
        // failed call — fall through to the coaching below
      }
    }

    if (!event.isError) return undefined;
    const originalText = event.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    if (UNKNOWN_TOOL_SIGNATURE.test(originalText.split('\n')[0] ?? '')) {
      let toolList: string;
      try {
        toolList = pi.getActiveTools().join(', ');
      } catch {
        toolList = FALLBACK_TOOL_LIST;
      }
      const input = event.input as unknown;
      appendLog({
        ts: new Date().toISOString(),
        tool: event.toolName,
        model: ctx.model?.id,
        outcome: 'failed',
        issues: 'unknown-tool',
        fingerprint: shapeFingerprint(event.toolName, input),
      });

      return {
        content: [
          {
            type: 'text',
            text: `${originalText}\n\nHenyo note: no such tool. Available tools: ${toolList} — re-emit the call with one of those.`,
          },
        ],
      };
    }

    // Content-mismatch errors (edit only — the signatures are edit-specific):
    // the dominant failure class for the served Qwen models. Coached with a
    // targeted one-line hint; telemetry records the category, not shape.
    if (event.toolName === 'edit') {
      const firstLine = originalText.split('\n')[0] ?? '';
      const rule = CONTENT_ERROR_RULES.find((r) => r.re.test(firstLine));
      if (rule) {
        const input = event.input as unknown;
        // Upgrade the one-line hint to the full report when the feature is
        // on and a report qualifies (assumption 11: nothing qualifies → the
        // existing one-line hint stays).
        let note = `Henyo note: ${rule.line}`;
        let issues = rule.category;
        if (
          opts.editFallbackEnabled &&
          (rule.category === 'content-not-found' || rule.category === 'content-not-unique')
        ) {
          const enhancement = await classifyContentError(
            rule.category,
            firstLine,
            event.input,
            ctx.cwd,
          );
          if (enhancement) {
            note = enhancement.replace
              ? `Henyo note: ${enhancement.extra}`
              : `Henyo note: ${rule.line}\n${enhancement.extra}`;
            issues = enhancement.issues;
          }
        }
        const ts = new Date().toISOString();
        const fingerprint = editLocationFingerprint(input) ?? shapeFingerprint('edit', input);
        // Telemetry v2: track the failure for recovery (per-file, A2).
        const fileKey = editFileKey(input);
        // Assumption 6: verbatim retry = a same-fingerprint failure is open
        // for this file and no successful `read` of it happened after that
        // failure (ISO-8601 ts compare is lexicographically correct).
        // File-scoped only: no resolvable path → no tracking, no flag
        // (matches the documented "no state pushed" no-leak behavior).
        const readTs = fileKey !== undefined ? (lastReadTs.get(fileKey) ?? '') : '';
        const retriedVerbatim =
          fileKey !== undefined &&
          (openFailures.get(fileKey) ?? []).some(
            (f) => f.fingerprint === fingerprint && f.ts > readTs,
          );
        appendLog({
          ts,
          tool: 'edit',
          model: ctx.model?.id,
          outcome: 'failed',
          issues,
          // Original category — `issues !== category` is the upgraded
          // subcategory / mislabel signal from the log alone.
          category: rule.category,
          fingerprint,
          ...(retriedVerbatim ? { retriedVerbatim: true } : {}),
        });
        if (fileKey !== undefined) {
          rememberOpenFailure(fileKey, {
            fingerprint,
            toolCallId: event.toolCallId,
            ts,
            issues,
            model: ctx.model?.id,
          });
        }

        return {
          content: [{ type: 'text', text: `${originalText}\n\n${note}` }],
        };
      }
    }

    if (
      !/Validation failed for tool "[a-z_]+"/.test(originalText) &&
      !/Invalid input for tool "[a-z_]+"/.test(originalText)
    ) {
      return undefined;
    }

    const coachingLine = event.toolName === 'edit' ? COACHING_LINE : GENERIC_COACHING_LINE;
    const input = event.input as unknown;
    const ts = new Date().toISOString();
    const issues = shapeDiagnostics(event.toolName, input);
    const fingerprint =
      event.toolName === 'edit'
        ? (editLocationFingerprint(input) ?? shapeFingerprint(event.toolName, input))
        : shapeFingerprint(event.toolName, input);
    const record: LogRecord = {
      ts,
      tool: event.toolName,
      model: ctx.model?.id,
      outcome: 'failed',
      issues,
      fingerprint,
    };
    // Assumption 6 (edit only): same-fingerprint open failure with no
    // successful `read` of the file in between → blind verbatim retry.
    if (event.toolName === 'edit') {
      const fileKey = editFileKey(input);
      if (fileKey !== undefined) {
        const readTs = lastReadTs.get(fileKey) ?? '';
        if (
          (openFailures.get(fileKey) ?? []).some(
            (f) => f.fingerprint === fingerprint && f.ts > readTs,
          )
        ) {
          record.retriedVerbatim = true;
        }
      }
    }
    // Telemetry v2 (plan A4): emission tag on validation-class failures only
    // — the classifier returns `undefined` for non-`edit` tools, so other
    // tools' records stay untouched.
    const emission = classifyEmission(event.toolName, input);
    if (emission) record.emission = emission;
    appendLog(record);
    // Telemetry v2: track the failure for recovery (edit only — the ok /
    // applied sites only fire for edit successes).
    if (event.toolName === 'edit') {
      const fileKey = editFileKey(input);
      if (fileKey !== undefined) {
        rememberOpenFailure(fileKey, {
          fingerprint,
          toolCallId: event.toolCallId,
          ts,
          issues,
          model: ctx.model?.id,
        });
      }
    }

    return {
      content: [{ type: 'text', text: `${originalText}\n\n${coachingLine}` }],
    };
  });

  // Hook 3 (O5): prevention — four guideline lines in the system prompt,
  // each with its own idempotency check (a prompt upgraded mid-session has
  // the old line but not the new one).
  pi.on('before_agent_start', (event) => {
    if (!opts.enabled) return undefined;
    let prompt = event.systemPrompt;
    let changed = false;
    if (!prompt.includes(PROMPT_LINE)) {
      prompt = `${prompt}\n\n${PROMPT_LINE}`;
      changed = true;
    }
    if (!prompt.includes(READ_BEFORE_EDIT_LINE)) {
      prompt = `${prompt}\n\n${READ_BEFORE_EDIT_LINE}`;
      changed = true;
    }
    if (!prompt.includes(TRUST_RESULT_LINE)) {
      prompt = `${prompt}\n\n${TRUST_RESULT_LINE}`;
      changed = true;
    }
    if (!prompt.includes(NO_BYPASS_LINE)) {
      prompt = `${prompt}\n\n${NO_BYPASS_LINE}`;
      changed = true;
    }
    return changed ? { systemPrompt: prompt } : undefined;
  });
}
