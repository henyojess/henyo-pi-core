/**
 * Tool repair extension — inline modular repair layer.
 *
 * Integrates with pi's extension system to wrap built-in tool `prepareArguments`
 * with the repair engine, inject `<repair_note>` into results, show TUI indicators,
 * and handle grammar leak recovery.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  getAgentDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { repairToolInput } from "./engine.js";
import { editConfig } from "./configs.js";
import type {
  RepairResult,
  RepairSettings,
} from "./types.js";
import {
  DEFAULT_REPAIR_SETTINGS,
  type TelemetryRecord,
} from "./types.js";
import {
  modelLeaksGrammar,
  recoverGrammarLeaks,
  type GrammarRecoveryMode,
  type MinimalAssistantMessage,
  type RecoveredToolCall,
} from "./grammar-recovery/index.js";

// ---------------------------------------------------------------------------
// Built-in tool factories
// ---------------------------------------------------------------------------

const BUILTIN_FACTORIES: Record<string, (cwd: string) => ToolDefinition<any, any>> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

// ---------------------------------------------------------------------------
// Tool configs — extend this map as new tools get configs
// ---------------------------------------------------------------------------

const TOOL_CONFIGS: Record<string, typeof editConfig> = {
  edit: editConfig,
};

// ---------------------------------------------------------------------------
// Settings — read from ~/.pi/agent/settings.json under henyo.toolRepair
// ---------------------------------------------------------------------------

const SETTINGS_PATH = join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".pi",
  "agent",
  "settings.json",
);

function loadRepairSettings(): RepairSettings {
  try {
    let settings: unknown = {};
    if (existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      } catch {
        settings = {};
      }
    }

    const henyo =
      settings && typeof settings === "object" && !Array.isArray(settings)
        ? (settings as Record<string, unknown>).henyo
        : undefined;

    const repair =
      henyo && typeof henyo === "object" && !Array.isArray(henyo)
        ? (henyo as Record<string, unknown>).toolRepair
        : undefined;

    const obj = repair && typeof repair === "object"
      ? (repair as Record<string, unknown>)
      : {};

    return {
      telemetry: typeof (obj.telemetry ?? DEFAULT_REPAIR_SETTINGS.telemetry) === "boolean"
        ? (obj.telemetry as boolean)
        : DEFAULT_REPAIR_SETTINGS.telemetry,
      debug: typeof (obj.debug ?? DEFAULT_REPAIR_SETTINGS.debug) === "boolean"
        ? (obj.debug as boolean)
        : DEFAULT_REPAIR_SETTINGS.debug,
      showIndicator: typeof (obj.showIndicator ?? DEFAULT_REPAIR_SETTINGS.showIndicator) === "boolean"
        ? (obj.showIndicator as boolean)
        : DEFAULT_REPAIR_SETTINGS.showIndicator,
      showNotes: typeof (obj.showNotes ?? DEFAULT_REPAIR_SETTINGS.showNotes) === "boolean"
        ? (obj.showNotes as boolean)
        : DEFAULT_REPAIR_SETTINGS.showNotes,
      grammarRecovery: isGrammarMode(obj.grammarRecovery)
        ? (obj.grammarRecovery as GrammarRecoveryMode)
        : DEFAULT_REPAIR_SETTINGS.grammarRecovery,
      grammarAllowedTools:
        Array.isArray(obj.grammarAllowedTools) &&
        obj.grammarAllowedTools.every((t: unknown) => typeof t === "string")
          ? (obj.grammarAllowedTools as string[])
          : [...(DEFAULT_REPAIR_SETTINGS.grammarAllowedTools ?? [])],
    };
  } catch {
    return { ...DEFAULT_REPAIR_SETTINGS };
  }
}

function isGrammarMode(value: unknown): value is GrammarRecoveryMode {
  return typeof value === "string" && ["off", "strip", "recover"].includes(value);
}

// ---------------------------------------------------------------------------
// Telemetry — JSONL at ~/.pi/agent/tool-repair/telemetry.jsonl
// ---------------------------------------------------------------------------

function telemetryPath(): string {
  return join(getAgentDir(), "tool-repair", "telemetry.jsonl");
}

function logTelemetry(record: TelemetryRecord): void {
  try {
    const path = telemetryPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    // Telemetry must never break tool execution.
  }
}

// ---------------------------------------------------------------------------
// Value strips (pre-pass) — adapted from existing value-strips.ts
// ---------------------------------------------------------------------------

/**
 * Model-gated value strips — runs before the engine on input that is valid
 * both before and after (anchor bleed, grammar token leaks).
 */
interface StripResult {
  changed: boolean;
  rules: string[];
  notes: string[];
}

const ANCHOR_BLEED_MODELS: readonly RegExp[] = [/kimi-k2/i, /minimax/i, /glm/i];
const GRAMMAR_LEAK_MODELS: readonly RegExp[] = [/glm/i];
const ANCHOR_STRIP_SKIP: Record<string, ReadonlySet<string>> = {
  grep: new Set(["pattern"]),
};
const STRIP_ANCHOR_RULE = "stripAnchorBleed";
const STRIP_GRAMMAR_RULE = "stripGrammarTokenLeak";

const GRAMMAR_TOKEN_LEAKS = [
  { tag: "<arg_key>", at: "start" as const },
  { tag: "</arg_key>", at: "end" as const },
  { tag: "<arg_value>", at: "start" as const },
  { tag: "</arg_value>", at: "end" as const },
];

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function modelMatches(modelId: string | undefined, families: readonly RegExp[]): boolean {
  if (!modelId) return false;
  return families.some((re) => re.test(modelId));
}

function stripAnchorsFromString(value: string): string {
  let s = value;
  while (s.startsWith("^")) s = s.slice(1);
  while (s.endsWith("$")) s = s.slice(0, -1);
  return s;
}

function stripGrammarTokens(value: string): string {
  let s = value;
  for (const { tag, at } of GRAMMAR_TOKEN_LEAKS) {
    if (at === "start") {
      while (s.startsWith(tag)) s = s.slice(tag.length);
    } else {
      while (s.endsWith(tag)) s = s.slice(0, -tag.length);
    }
  }
  return s;
}

function stripValues(options: {
  toolName: string;
  input: unknown;
  modelId?: string;
}): { result: StripResult; input: unknown } {
  const result: StripResult = { changed: false, rules: [], notes: [] };
  if (!isContainer(options.input)) return { result, input: options.input };

  const input = options.input as Record<string, unknown>;
  const modelId = options.modelId;

  // Anchor bleed strip — model-gated
  if (modelMatches(modelId, ANCHOR_BLEED_MODELS)) {
    const skipFields = ANCHOR_STRIP_SKIP[options.toolName];
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (typeof value !== "string") continue;
      if (skipFields?.has(key)) continue;
      const stripped = stripAnchorsFromString(value);
      if (stripped !== value) {
        input[key] = stripped;
        result.changed = true;
        result.rules.push(STRIP_ANCHOR_RULE);
        result.notes.push(
          `Stripped regex anchor bleed from \`${key}\` for tool "${options.toolName}". Anchors (^/$) in values are usually accidental — the model should send clean strings.`,
        );
      }
    }
  }

  // Grammar token leak strip — model-gated
  if (modelMatches(modelId, GRAMMAR_LEAK_MODELS)) {
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const stripped = stripGrammarTokens(value);
      if (stripped !== value) {
        input[key] = stripped;
        result.changed = true;
        result.rules.push(STRIP_GRAMMAR_RULE);
        result.notes.push(
          `Stripped leaked grammar tokens from \`${key}\` for tool "${options.toolName}". The model printed grammar markers as literal text.`,
        );
      }
    }
  }

  return { result, input };
}

// ---------------------------------------------------------------------------
// TUI indicator component
// ---------------------------------------------------------------------------

class RepairIndicatorComponent {
  inner: { render(width: number): string[] } | undefined;
  extraLines: string[] = [];

  render(width: number): string[] {
    const lines = this.inner?.render(width) ?? [];
    return this.extraLines.length > 0 ? [...lines, ...this.extraLines] : lines;
  }
}

// ---------------------------------------------------------------------------
// Pending repairs tracking
// ---------------------------------------------------------------------------

const NOTE_TTL_MS = 5 * 60 * 1000;

interface PendingRepair {
  argsJson: string;
  rules: string[];
  notes: string[];
  ts: number;
}

interface RepairInfo {
  rules: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Tool repair extension — wraps built-in tool definitions with the repair engine.
 *
 * @param pi — The pi ExtensionAPI instance.
 */
export default function toolRepairExtension(pi: ExtensionAPI): void {
  let currentModelId: string | undefined;
  let registeredCwd: string | undefined;
  const settings: RepairSettings = loadRepairSettings();
  const pendingRepairs = new Map<string, PendingRepair[]>();
  const repairInfoByCallId = new Map<string, RepairInfo>();

  const stashRepair = (
    tool: string,
    argsJson: string,
    rules: string[],
    notes: string[],
  ): void => {
    const queue = pendingRepairs.get(tool) ?? [];
    const now = Date.now();
    const fresh = queue.filter((entry) => now - entry.ts < NOTE_TTL_MS);
    fresh.push({ argsJson, rules, notes, ts: now });
    pendingRepairs.set(tool, fresh);
  };

  const takeRepair = (
    tool: string,
    argsJson: string,
  ): PendingRepair | undefined => {
    const queue = pendingRepairs.get(tool);
    if (!queue) return undefined;
    const index = queue.findIndex((entry) => entry.argsJson === argsJson);
    if (index === -1) return undefined;
    const [entry] = queue.splice(index, 1);
    return entry;
  };

  const indicatorLines = (
    info: RepairInfo,
    theme: { fg?: (color: string, text: string) => string },
  ): string[] => {
    if (!settings.showIndicator) return [];
    const muted = (text: string) => {
      try {
        return theme?.fg ? theme.fg("muted", text) : text;
      } catch {
        return text;
      }
    };
    const lines = [muted(`🔨 ✓ input repaired (${info.rules.join(", ")})`)];
    if (settings.showNotes) {
      for (const note of info.notes) lines.push(muted(`   ↳ ${note}`));
    }
    return lines;
  };

  const registerOverrides = (cwd: string): void => {
    if (registeredCwd === cwd) return;
    registeredCwd = cwd;

    for (const [name, factory] of Object.entries(BUILTIN_FACTORIES)) {
      const original = factory(cwd) as ToolDefinition<any, any>;
      const config = TOOL_CONFIGS[name];
      const originalPrepare = original.prepareArguments;
      const originalRenderResult = original.renderResult?.bind(original);

      pi.registerTool({
        ...original,
        prepareArguments(raw: unknown): unknown {
          let shimmed = raw;
          if (originalPrepare) {
            try {
              shimmed = originalPrepare(raw);
            } catch {
              shimmed = raw;
            }
          }

          // Value-strip pre-pass: model-gated strips run before the engine
          const strip = stripValues({
            toolName: name,
            input: shimmed,
            modelId: currentModelId,
          });
          const engineInput = strip.result.changed ? strip.input : shimmed;

          // Run the repair engine
          let result: RepairResult;
          if (config) {
            result = repairToolInput(config, engineInput, name);
          } else {
            // No config — pass through
            result = {
              outcome: "valid",
              args: engineInput,
              rulesFired: [],
              notes: [],
              issueSummary: undefined,
              fingerprint: undefined,
              retryMessage: undefined,
            };
          }

          if (result.outcome === "valid") {
            if (!strip.result.changed) return shimmed;
            logTelemetry({
              ts: new Date().toISOString(),
              tool: name,
              model: currentModelId,
              outcome: "repaired",
              rules: strip.result.rules,
            });
            stashRepair(name, JSON.stringify(engineInput), strip.result.rules, strip.result.notes);
            return engineInput;
          }

          if (settings.debug) {
            process.stderr.write(
              `[pi-repair] tool=${name} outcome=${result.outcome} rules=${result.rulesFired.join(",")}${
                result.issueSummary ? ` issues=${result.issueSummary}` : ""
              }\n`,
            );
          }

          logTelemetry({
            ts: new Date().toISOString(),
            tool: name,
            model: currentModelId,
            outcome: result.outcome,
            rules: [...strip.result.rules, ...result.rulesFired],
            issues: result.issueSummary,
            fingerprint: result.fingerprint,
          });

          if (result.outcome === "repaired") {
            stashRepair(
              name,
              JSON.stringify(result.args),
              [...strip.result.rules, ...result.rulesFired],
              [...strip.result.notes, ...result.notes],
            );
            return result.args;
          }

          // Unrepairable — throw retry message
          if (result.retryMessage) {
            throw new Error(result.retryMessage);
          }
          return engineInput;
        },
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const repair = takeRepair(name, JSON.stringify(params));
          if (repair) {
            repairInfoByCallId.set(toolCallId, {
              rules: repair.rules,
              notes: repair.notes,
            });
            try {
              pi.appendEntry("tool-repair", {
                toolCallId,
                tool: name,
                rules: repair.rules,
                notes: repair.notes,
              });
            } catch {
              // Best-effort persistence
            }
          }

          const result = await original.execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );

          if (repair && repair.notes.length > 0) {
            const noteText = repair.notes
              .map((note) => `<repair_note>${note}</repair_note>`)
              .join("\n");
            const first = Array.isArray(result.content)
              ? result.content[0]
              : undefined;
            if (first?.type === "text") {
              first.text = `${noteText}\n${first.text}`;
            } else if (Array.isArray(result.content)) {
              result.content.unshift({ type: "text", text: noteText });
            }
          }

          return result;
        },
        ...(originalRenderResult
          ? {
              renderResult(
                result: any,
                options: any,
                theme: any,
                context: any,
              ) {
                const info = repairInfoByCallId.get(context.toolCallId);
                const last = context.lastComponent;
                const wrapper =
                  last instanceof RepairIndicatorComponent
                    ? last
                    : info
                      ? new RepairIndicatorComponent()
                      : undefined;
                if (!wrapper)
                  return originalRenderResult(result, options, theme, context);
                wrapper.inner = originalRenderResult(result, options, theme, {
                  ...context,
                  lastComponent: wrapper.inner,
                });
                wrapper.extraLines = info ? indicatorLines(info, theme) : [];
                return wrapper as any;
              },
            }
          : {}),
      });
    }
  };

  // ─── Event hooks ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentModelId = ctx.model?.id;
    registerOverrides(ctx.cwd);

    // Restore indicators for repairs recorded earlier in this session
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        const e = entry as { type?: string; customType?: string; data?: any };
        if (
          e.type === "custom" &&
          e.customType === "tool-repair" &&
          typeof e.data?.toolCallId === "string"
        ) {
          repairInfoByCallId.set(e.data.toolCallId, {
            rules: Array.isArray(e.data.rules) ? e.data.rules : [],
            notes: Array.isArray(e.data.notes) ? e.data.notes : [],
          });
        }
      }
    } catch {
      // Older pi versions may not expose entries
    }
  });

  pi.on("model_select", async (event, ctx) => {
    currentModelId =
      (event as { model?: { id?: string } }).model?.id ??
      ctx.model?.id ??
      undefined;
  });

  // Grammar-leak recovery on message_end
  const safeGetActiveTools = (): string[] => {
    try {
      return (
        (pi as { getActiveTools?: () => string[] }).getActiveTools?.() ?? []
      );
    } catch {
      return [];
    }
  };

  pi.on("message_end", async (event, _ctx) => {
    if (settings.grammarRecovery === "off") return undefined;
    const message = (event as unknown as { message?: MinimalAssistantMessage })
      .message;
    if (message?.role !== "assistant") return undefined;
    if (!modelLeaksGrammar(currentModelId)) return undefined;

    const allowed = settings.grammarAllowedTools ?? [];
    const knownTools = new Set(
      allowed.length > 0 ? allowed : safeGetActiveTools(),
    );

    const result = recoverGrammarLeaks(message, {
      mode: settings.grammarRecovery,
      knownTools,
      requireKnownTool: true,
    });

    if (!result.changed) return undefined;

    if (result.promoted) {
      for (const call of result.recoveredCalls) {
        const note = `Recovered a leaked ${call.grammar} tool call for "${call.name}" that the model printed as text instead of emitting a real tool call. Emit a proper tool call next time.`;
        stashRepair(
          call.name,
          JSON.stringify(call.arguments),
          [`grammarRecovery:${call.grammar}`],
          [note],
        );
        logTelemetry({
          ts: new Date().toISOString(),
          tool: call.name,
          model: currentModelId,
          outcome: "recovered",
          rules: [`grammarRecovery:${call.grammar}`],
          grammar: call.grammar,
        });
      }
    } else {
      logTelemetry({
        ts: new Date().toISOString(),
        model: currentModelId,
        outcome: "stripped",
        rules: ["grammarStrip"],
        channel: "message",
        grammar:
          result.strippedGrammars.length > 0
            ? result.strippedGrammars.join(",")
            : undefined,
      });
    }

    return { message: result.message as any };
  });

  // ─── Commands ──────────────────────────────────────────────────────────

  const nextGrammarMode = (mode: GrammarRecoveryMode): GrammarRecoveryMode =>
    mode === "off" ? "strip" : mode === "strip" ? "recover" : "off";

  pi.registerCommand("repair-settings", {
    description:
      "Toggle the tool-repair indicator (🔨), repair-note display, and grammar recovery",
    handler: async (_args, ctx) => {
      for (;;) {
        const indicatorLabel = `Repair indicator (🔨 ✓): ${settings.showIndicator ? "on" : "off"} — toggle`;
        const notesLabel = `Repair note text beneath indicator: ${settings.showNotes ? "on" : "off"} — toggle`;
        const grammarLabel = `Grammar-leak recovery: ${settings.grammarRecovery} — cycle (off → strip → recover)`;
        const choice = await ctx.ui.select("Tool repair display settings", [
          indicatorLabel,
          notesLabel,
          grammarLabel,
          "Close",
        ]);
        if (choice === undefined || choice === "Close") break;
        if (choice === indicatorLabel)
          settings.showIndicator = !settings.showIndicator;
        if (choice === notesLabel)
          settings.showNotes = !settings.showNotes;
        if (choice === grammarLabel)
          settings.grammarRecovery = nextGrammarMode(settings.grammarRecovery);
      }
      ctx.ui.notify(
        `Repair display: indicator ${settings.showIndicator ? "on" : "off"}, notes ${
          settings.showNotes ? "on" : "off"
        }, grammar recovery ${settings.grammarRecovery} (applies from now on)`,
        "info",
      );
    },
  });

  pi.registerCommand("repair-stats", {
    description: "Summarize tool-input repair telemetry",
    handler: async (_args, ctx) => {
      const path = telemetryPath();
      if (!existsSync(path)) {
        ctx.ui.notify("No repair telemetry recorded yet.", "info");
        return;
      }

      type ToolCounts = {
        repaired: number;
        unrepairable: number;
        recovered: number;
      };

      const emptyCounts = (): ToolCounts => ({
        repaired: 0,
        unrepairable: 0,
        recovered: 0,
      });

      const byTool = new Map<string, ToolCounts>();
      const byRule = new Map<string, number>();
      const byModel = new Map<string, ToolCounts>();
      const byGrammar = new Map<string, number>();
      let stripOnlyEvents = 0;
      let toolEvents = 0;

      const bump = (
        counts: ToolCounts,
        outcome: string,
      ) => {
        if (
          outcome === "repaired" ||
          outcome === "unrepairable" ||
          outcome === "recovered"
        )
          counts[outcome as keyof ToolCounts] += 1;
      };

      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as TelemetryRecord & { channel?: string; grammar?: string };

          for (const rule of record.rules)
            byRule.set(rule, (byRule.get(rule) ?? 0) + 1);

          if (record.channel === "message") {
            stripOnlyEvents += 1;
            for (const family of (record.grammar ?? "unknown").split(","))
              byGrammar.set(family, (byGrammar.get(family) ?? 0) + 1);
          } else {
            toolEvents += 1;
            const key = record.tool ?? "unknown";
            const tool = byTool.get(key) ?? emptyCounts();
            bump(tool, record.outcome);
            byTool.set(key, tool);
            const model = byModel.get(record.model ?? "unknown") ?? emptyCounts();
            bump(model, record.outcome);
            byModel.set(record.model ?? "unknown", model);
          }
        } catch {
          // Skip malformed lines
        }
      }

      const fmt = (c: ToolCounts) =>
        `${c.repaired} repaired, ${c.recovered} recovered, ${c.unrepairable} unrepairable`;
      const lines = [
        `Tool repair telemetry (${toolEvents + stripOnlyEvents} events: ${toolEvents} tool, ${stripOnlyEvents} grammar strip-only)`,
        "",
        "By tool:",
      ];

      for (const [tool, counts] of [...byTool].sort(
        (a, b) =>
          b[1].repaired + b[1].recovered - (a[1].repaired + a[1].recovered),
      )) {
        lines.push(`  ${tool}: ${fmt(counts)}`);
      }

      lines.push("", "By model:");
      for (const [model, counts] of [...byModel].sort(
        (a, b) =>
          b[1].repaired + b[1].recovered - (a[1].repaired + a[1].recovered),
      )) {
        lines.push(`  ${model}: ${fmt(counts)}`);
      }

      if (byGrammar.size > 0) {
        lines.push("", "Grammar strip-only events (message channel):");
        for (const [family, count] of [...byGrammar].sort(
          (a, b) => b[1] - a[1],
        )) {
          lines.push(`  ${family}: ${count}`);
        }
      }

      lines.push("", "Rules fired:");
      for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${rule}: ${count}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
