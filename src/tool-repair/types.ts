/**
 * Core types and interfaces for the inline modular repair framework.
 *
 * No implementation — only contracts that other modules depend on.
 */

import type { TSchema } from "typebox";

// ---------------------------------------------------------------------------
// Middleware types
// ---------------------------------------------------------------------------

/**
 * Structured validation issue emitted by TypeBox's Value.Errors / AJV.
 */
export interface RawIssue {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown> | undefined;
  message: string | undefined;
}

/**
 * Context passed to every middleware invocation.
 */
export interface MiddlewareContext {
  toolName: string;
  schema: TSchema;
  issues?: RawIssue[];
}

/**
 * Result returned by a middleware. `changed: true` means the input was mutated.
 */
export type MiddlewareResult =
  | { changed: true; note: string }
  | { changed: false };

/**
 * A middleware function — receives input (mutated in place) and context,
 * returns whether it made a change and a model-facing note.
 */
export type ToolMiddleware = (
  input: Record<string, unknown>,
  ctx: MiddlewareContext,
) => MiddlewareResult;

// ---------------------------------------------------------------------------
// Engine types
// ---------------------------------------------------------------------------

/**
 * Configuration for a single tool's repair pipeline.
 */
export interface ToolRepairConfig {
  /** TypeBox schema for the tool's input parameters. */
  schema: TSchema;
  /** Ordered list of middleware to run during repair. */
  middleware: ToolMiddleware[];
  /** Canonical field name -> list of aliases the model might emit. */
  fieldAliases?: Record<string, readonly string[]>;
  /** Top-level string fields that hold filesystem paths (auto-link unwrapping). */
  pathFields?: readonly string[];
}

/**
 * Outcome of running the repair engine on a tool input.
 */
export interface RepairResult {
  outcome: "valid" | "repaired" | "unrepairable";
  /** What prepareArguments should return. */
  args: unknown;
  /** Rule / middleware names that fired. */
  rulesFired: string[];
  /** Model-facing notes (one per fired rule, deduplicated). */
  notes: string[];
  /** Compact description of the original validation failure, for telemetry. */
  issueSummary: string | undefined;
  /** Stable hash of (tool, failure shape), for spotting per-model regressions. */
  fingerprint: string | undefined;
  /**
   * Model-readable error for unrepairable input. Throwing this from
   * prepareArguments prevents Value.Convert from silently corrupting it.
   */
  retryMessage: string | undefined;
}

// ---------------------------------------------------------------------------
// Telemetry types
// ---------------------------------------------------------------------------

/**
 * A single JSONL telemetry record written to the repair log.
 */
export interface TelemetryRecord {
  ts: string;
  tool?: string;
  model: string | undefined;
  outcome: "repaired" | "unrepairable" | "recovered" | "stripped";
  rules: string[];
  issues?: string;
  fingerprint?: string;
  /** "tool" (default) or "message" channel. */
  channel?: "tool" | "message";
  /** Grammar family for recovered/stripped events. */
  grammar?: string;
}

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

/**
 * Grammar-leak recovery mode.
 *  - "off": never touch assistant text.
 *  - "strip": remove leaked grammar from text (model-gated), never promote.
 *  - "recover": additionally promote leaked calls to real toolCalls.
 */
export type GrammarRecoveryMode = "off" | "strip" | "recover";

/**
 * Repair layer settings, read from ~/.pi/agent/settings.json under `henyo.toolRepair`.
 */
export interface RepairSettings {
  telemetry: boolean;
  debug: boolean;
  showIndicator: boolean;
  showNotes: boolean;
  grammarRecovery: GrammarRecoveryMode;
  /** Allowlist of tools for grammar recovery promotion. Empty = all active tools. */
  grammarAllowedTools?: string[];
}

/**
 * Default values for repair settings.
 */
export const DEFAULT_REPAIR_SETTINGS: RepairSettings = {
  telemetry: true,
  debug: false,
  showIndicator: true,
  showNotes: true,
  grammarRecovery: "off",
  grammarAllowedTools: [],
};
