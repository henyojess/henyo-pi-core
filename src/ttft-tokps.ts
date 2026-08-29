/**
 * TTFT + tok/s on the Working line — v2 (ported from the standalone
 * `ttft-tokps` extension; display logic verbatim).
 *
 * Live tok/s while streaming + final exact tok/s at message_end + TTFT.
 * When `traceEnabled`, logs to `logFile` (JSONL) so
 * live-estimate-vs-final error stays measurable; off by default.
 *
 * Token estimation (per channel — the big accuracy fix over v1):
 *   - Counts all three delta channels: thinking_delta / text_delta /
 *     toolcall_delta. NOTE: v1 missed toolcall_delta entirely — tool-call
 *     argument generation (270–1066 tokens/call at 25–60 tok/s) was
 *     invisible, so the live rate looked frozen mid-generation.
 *   - Per-channel chars→tokens ratios (think/text/tool), per-model, EMA
 *     with token half-life α = 1−2^(−n/500), clamped 1.5–8, calibrated at
 *     message_end from exact usage:
 *       think = thinkChars/usage.reasoning (exact when streamed)
 *       tool  = toolChars/(output−reasoning)   [tool-only calls]
 *       text  = textChars/(output−reasoning)   [text-only calls]
 *     Updates skipped when the derived ratio is outside the clamp
 *     (truncation / unstreamed-thinking guard) or on aborted/error.
 *   - Exact usage path: non-zero partial.usage.output mid-stream → used
 *     directly (zero estimation error); chars path is the fallback.
 *   - Per-model display correction k (EMA α=0.2, clamp 0.5–2.0): the
 *     chars-estimate live rate is scaled by k, calibrated at message_end
 *     from exact output / raw estimate — keeps live ≈ final even when the
 *     server's per-channel token counts are noisy. Exact path: k=1 by
 *     construction (never applied to exact usage).
 *   - Generation span = first→last delta of any channel (excludes tool
 *     execution pauses + server endLag).
 *   - Display gate: `…` until estTokens ≥ 50 or exact usage seen.
 *   - Rates shown to 2 decimals (like TTFT) — the fraction moves every
 *     delta, so the number visibly ticks while streaming.
 *   - Stall hold: no delta of any kind for 1500ms → hold last rate + `…`.
 *   - Final hold: the `tok/s (final)` readout stays on the working line for
 *     FINAL_HOLD_MS (5s), then the default line is restored; a new LLM call
 *     (before_provider_request) cancels the hold immediately.
 *
 * Timing anchors (per LLM call):
 *   before_provider_request -> request sent  (TTFT start)
 *   first delta of any channel                    (TTFT end)
 *   message_end -> usage.output                   (exact output tokens)
 *
 * Timestamps: performance.now() (monotonic — Date.now() can jump).
 *
 * State v2: {v:2, ratios:{modelKey|__default__:{think,text,tool}},
 * bias:{modelKey|__default__:k}} in statePath — survives /reload and
 * restarts.
 *
 * NOTE: agent_start fires once per user prompt (agent loop), NOT per LLM
 * call — turns repeat per LLM call. State is reset on message_start.
 */

import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Default trace log path (used when `traceEnabled` and no `logFile` given). */
const DEFAULT_LOG_FILE = '/tmp/ttft-debug.log';
/** Default trace log size cap (10 MB) before rotation. */
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
/** Default number of rotated backup files to keep (`.1`–`.N`). */
const DEFAULT_MAX_BACKUPS = 3;
const RATIO_MIN = 1.5;
const RATIO_MAX = 8;
/** endLag beyond this = untrusted span: final rate falls back to wall clock. */
const LARGE_END_LAG_MS = 5000;
/** Ratio EMA token half-life: α per update = 1 − 2^(−tokens/500). */
const RATIO_HALF_LIFE_TOKENS = 500;
/** Display gate: show a number only after ≥ this many estimated tokens. */
const MIN_DISPLAY_TOKENS = 50;
/** Live-estimate correction k: per-call EMA α and clamp range. */
const BIAS_ALPHA = 0.2;
const BIAS_MIN = 0.5;
const BIAS_MAX = 2.0;
/** No delta of any kind for this long = stall → hold last rate + `…`. */
const STALL_MS = 1500;
const STALL_TICK_MS = 500;
/** The `tok/s (final)` readout stays this long on the working line. */
const FINAL_HOLD_MS = 5000;

export interface TtftTokpsOptions {
  /** JSONL debug trace on/off. Default false — no log file is created at all. */
  traceEnabled?: boolean;
  /** State file path. Default: <agentDir>/extensions/.ttft-tokps-state.json. */
  statePath?: string;
  /** Trace log path. Default: /tmp/ttft-debug.log. */
  logFile?: string;
  /** Rotate the trace log once it reaches this many bytes. Default 10 MB. */
  maxLogBytes?: number;
  /** Rotated backups to keep (`.1`–`.N`, oldest overwritten). Default 3. */
  maxBackups?: number;
}

type Channel = 'think' | 'text' | 'tool';
interface ChannelRatios {
  think: number;
  text: number;
  tool: number;
}
/** Per-channel seed chars→tokens (measured from this provider's 21 calls). */
const SEED_RATIOS: ChannelRatios = { think: 3.62, text: 2.64, tool: 2.63 };
/** Monotonic clock (Date.now() can jump and corrupt spans). */
const now = () => performance.now();
const round2 = (n: number) => Math.round(n * 100) / 100;

interface StateV2 {
  v: 2;
  ratios: Record<string, ChannelRatios>;
  bias?: Record<string, number>;
  savedAt: number;
}

function loadRatios(key: string, statePath: string): ChannelRatios {
  const pick = (r: unknown, c: Channel, seed: number): number => {
    const v = typeof r === 'object' && r !== null ? (r as Record<Channel, unknown>)[c] : undefined;
    return typeof v === 'number' && v >= RATIO_MIN && v <= RATIO_MAX ? v : seed;
  };
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StateV2>;
    if (raw?.v !== 2) return { ...SEED_RATIOS }; // v1/legacy or corrupt → seeds; saveModelState overwrites
    const entry = raw.ratios?.[key] ?? raw.ratios?.['__default__'];
    return {
      think: pick(entry, 'think', SEED_RATIOS.think),
      text: pick(entry, 'text', SEED_RATIOS.text),
      tool: pick(entry, 'tool', SEED_RATIOS.tool),
    };
  } catch {
    return { ...SEED_RATIOS };
  }
}

function loadBias(key: string, statePath: string): number {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StateV2>;
    if (raw?.v !== 2) return 1;
    const v = raw.bias?.[key];
    return typeof v === 'number' && v >= BIAS_MIN && v <= BIAS_MAX ? v : 1;
  } catch {
    return 1;
  }
}

function saveModelState(key: string, ratios: ChannelRatios, bias: number, statePath: string): void {
  try {
    const state: StateV2 = { v: 2, ratios: {}, savedAt: Date.now() };
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<StateV2>;
      if (raw?.v === 2 && raw.ratios) state.ratios = raw.ratios; // v1 file gets overwritten
      if (raw?.v === 2 && raw.bias) state.bias = raw.bias;
    } catch {
      // fresh state
    }
    state.ratios[key] = ratios;
    if (!state.bias) state.bias = {};
    state.bias[key] = bias;
    state.savedAt = Date.now();
    writeFileSync(statePath, JSON.stringify(state, null, '\t'));
  } catch {
    // non-fatal
  }
}

/** EMA update with token half-life (small calls nudge, big calls dominate). */
function emaStep(current: number, sample: number, tokens: number): number {
  const alpha = 1 - Math.pow(2, -tokens / RATIO_HALF_LIFE_TOKENS);
  return current * (1 - alpha) + sample * alpha;
}

export function ttftTokpsExtension(pi: ExtensionAPI, opts: TtftTokpsOptions = {}): void {
  const traceEnabled = opts.traceEnabled ?? false;
  const statePath = opts.statePath ?? join(getAgentDir(), 'extensions', '.ttft-tokps-state.json');
  const logFile = opts.logFile ?? DEFAULT_LOG_FILE;
  const maxLogBytes = opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const maxBackups = opts.maxBackups ?? DEFAULT_MAX_BACKUPS;

  /**
   * Rotate the trace log if it reached the size cap.
   * Keeps up to `maxBackups` backup files (`.1` = newest, oldest is
   * overwritten). Silent-fail — rotation must never break the session.
   */
  function rotateLog(): void {
    if (!existsSync(logFile)) return;
    const stats = statSync(logFile);
    if (stats.size < maxLogBytes) return;
    // Rotate: .1 -> .2 -> ... -> .N (oldest backup is overwritten)
    for (let i = maxBackups; i >= 1; i--) {
      const dst = `${logFile}.${i}`;
      if (i === 1) {
        // Move current log to .1
        if (existsSync(logFile)) {
          renameSync(logFile, dst);
        }
      } else {
        // Shift backups
        const prev = `${logFile}.${i - 1}`;
        if (existsSync(prev)) {
          renameSync(prev, dst);
        }
      }
    }
  }

  const log = (entry: Record<string, unknown>): void => {
    if (!traceEnabled) return; // no stat, no append, no file creation when off
    try {
      rotateLog();
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), ...entry })}\n`,
      );
    } catch {
      // never break the working line over logging
    }
  };

  let requestStartMs = 0; // before_provider_request (per LLM call)
  let msgStartMs = 0; // message_start (assistant)
  let firstTokenMs: number | null = null;
  let lastDeltaMs: number | null = null;
  let deltaCount = 0;
  /** Per-channel streamed chars (thinking / text / tool-call args). */
  let chars: { think: number; text: number; tool: number } = { think: 0, text: 0, tool: 0 };
  /** Per-model calibrated chars→tokens ratios (EMA, token half-life). */
  let modelKey = '__default__';
  let ratios: ChannelRatios = loadRatios(modelKey, statePath);
  /** Per-model live-estimate correction k (EMA of exact/raw estimate). */
  let liveBias = loadBias(modelKey, statePath);
  /** Exact output tokens if the server reports partial.usage mid-stream. */
  let exactOutput: number | null = null;
  /** Stall detector (created on first delta, cleared at message_end). */
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Final readout hold (set at message_end, cancelled by a new LLM call). */
  let finalClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per LLM call — guards the final-hold timer. */
  let callSeq = 0;
  let activeCtx: { ui: { setWorkingMessage: (msg: string | undefined) => void } } | null = null;
  let lastLoggedUsage: string | null = null; // server-reported usage (JSON), logged on change
  let lastLive: {
    tps: string;
    estTokens: number;
    exact: boolean;
    secs: number;
    ch: { think: number; text: number; tool: number };
    ratios: { think: number; text: number; tool: number };
    bias: number;
    deltaCount: number;
  } | null = null;
  log({
    ev: 'init',
    modelKey,
    ratios: { think: round2(ratios.think), text: round2(ratios.text), tool: round2(ratios.tool) },
  });

  const fmtSeconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const anchorMs = () => requestStartMs || msgStartMs;

  function clearStall(): void {
    if (stallTimer !== null) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
  }
  function clearFinal(): void {
    if (finalClearTimer !== null) {
      clearTimeout(finalClearTimer);
      finalClearTimer = null;
    }
  }
  /** No delta of any kind for STALL_MS → hold last rate + `…` (invisible work). */
  function tickStall(): void {
    if (lastDeltaMs === null || activeCtx === null) return;
    if (now() - lastDeltaMs < STALL_MS) return;
    const held = lastLive?.tps && lastLive.tps !== '…' ? lastLive.tps : null;
    activeCtx.ui.setWorkingMessage(held ? `Working... ${held} …` : 'Working... …');
  }

  pi.on('agent_start', (_event, ctx) => {
    activeCtx = ctx;
    log({ ev: 'agent_start' });
    ctx.ui.setWorkingMessage('Working...');
  });

  pi.on('turn_start', (_event, _ctx) => {
    log({ ev: 'turn_start' });
  });

  pi.on('before_provider_request', (_event, ctx) => {
    callSeq += 1;
    clearFinal(); // the new call takes over the working line
    ctx.ui.setWorkingMessage(undefined);
    requestStartMs = now();
    modelKey = `${ctx.model?.provider ?? '?'}/${ctx.model?.id ?? '?'}`;
    ratios = loadRatios(modelKey, statePath);
    liveBias = loadBias(modelKey, statePath);
    log({
      ev: 'before_provider_request',
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
      ratios: { think: round2(ratios.think), text: round2(ratios.text), tool: round2(ratios.tool) },
      bias: round2(liveBias),
    });
  });

  pi.on('message_start', (event, _ctx) => {
    const role = event.message.role;
    log({ ev: 'message_start', role });
    if (role === 'assistant') {
      msgStartMs = now();
      firstTokenMs = null;
      lastDeltaMs = null;
      chars = { think: 0, text: 0, tool: 0 };
      deltaCount = 0;
      exactOutput = null;
      lastLoggedUsage = null;
      lastLive = null;
    }
  });

  pi.on('message_update', (event, ctx) => {
    const ev = event.assistantMessageEvent;
    // Only the three delta variants carry streamed chars (this guard also
    // narrows `ev` so `delta`/`partial` type-check — identical behavior to
    // the standalone's `if (!channel) return;`).
    if (ev.type !== 'thinking_delta' && ev.type !== 'text_delta' && ev.type !== 'toolcall_delta') {
      return;
    }
    let channel: Channel;
    if (ev.type === 'thinking_delta') channel = 'think';
    else if (ev.type === 'text_delta') channel = 'text';
    else channel = 'tool';

    // Inference server's own token stats, if it reports them in-stream
    // (pi requests stream_options.include_usage; vLLM & co. emit usage on
    // the final chunk, some servers per chunk). Log only when it changes.
    const serverUsage = ev.partial?.usage;
    if (serverUsage) {
      const key = JSON.stringify(serverUsage);
      if (key !== lastLoggedUsage) {
        lastLoggedUsage = key;
        log({ ev: 'server_usage', deltaType: ev.type, deltaCount, usage: serverUsage });
      }
    }
    // Exact path: non-zero output mid-stream → use it directly.
    if (typeof serverUsage?.output === 'number' && serverUsage.output > 0) {
      exactOutput = serverUsage.output;
    }
    const t = now();
    if (firstTokenMs === null) {
      firstTokenMs = t;
      log({
        ev: 'first_token',
        deltaType: ev.type,
        ttftMs: anchorMs() ? t - anchorMs() : null,
      });
    }
    lastDeltaMs = t;
    chars[channel] += ev.delta.length;
    deltaCount += 1;
    if (stallTimer === null) stallTimer = setInterval(tickStall, STALL_TICK_MS);
    const ttft = firstTokenMs !== null && anchorMs() ? fmtSeconds(firstTokenMs - anchorMs()) : '--';
    const secs = (t - firstTokenMs) / 1000;
    // Chars-estimate, scaled by the per-model correction k (display-
    // level fix — k is calibrated against exact usage at message_end).
    // The exact path bypasses k: the count is already exact.
    const rawEst = Math.max(
      1,
      Math.round(chars.think / ratios.think + chars.text / ratios.text + chars.tool / ratios.tool),
    );
    const estTokens = exactOutput ?? Math.max(1, Math.round(rawEst * liveBias));
    // Gate: no number off a tiny sample (unless exact usage is available).
    const unGated = estTokens >= MIN_DISPLAY_TOKENS || exactOutput !== null;
    const tps = unGated && secs > 0.2 ? `≈${(estTokens / secs).toFixed(2)} tok/s` : '…';
    ctx.ui.setWorkingMessage(`Working... TTFT ${ttft} · ${tps}`);
    // Remember what was displayed so message_end can compare it to the
    // exact final rate (how far the estimate was off).
    lastLive = {
      tps,
      estTokens: rawEst, // raw (unbiased) — the k calibration target
      exact: exactOutput !== null,
      secs: Math.round(secs * 100) / 100,
      ch: { ...chars },
      ratios: { think: round2(ratios.think), text: round2(ratios.text), tool: round2(ratios.tool) },
      bias: round2(liveBias),
      deltaCount,
    };
    if (deltaCount % 25 === 0) {
      log({ ev: 'sample', deltaCount, sinceFirstMs: t - firstTokenMs, displayed: lastLive });
    }
  });

  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant') {
      log({ ev: 'message_end', role: event.message.role });
      return;
    }
    clearStall();
    const usage = event.message.usage;
    const output = typeof usage?.output === 'number' ? usage.output : undefined;
    const reasoning = typeof usage?.reasoning === 'number' ? usage.reasoning : 0;
    const stopReason = event.message.stopReason;
    const t = now();
    const streamMs = firstTokenMs !== null ? t - firstTokenMs : null;
    // The true generation span ends at the last delta of any channel;
    // message_end can lag the last token (provider finalization/usage chunk).
    const tokenSpanMs =
      firstTokenMs !== null && lastDeltaMs !== null ? lastDeltaMs - firstTokenMs : null;
    const endLagMs = lastDeltaMs !== null ? t - lastDeltaMs : null;
    // Large endLag = server kept generating after the last delta (genuinely
    // unstreamed tail / stalled stream): the displayed final rate falls
    // back to wall clock for that call.
    const largeEndLag = endLagMs !== null && endLagMs > LARGE_END_LAG_MS;
    const wallTps =
      output !== undefined && output > 0 && streamMs !== null && streamMs > 200
        ? (output / (streamMs / 1000)).toFixed(2)
        : null;
    const tpsToLastDelta =
      output !== undefined && output > 0 && tokenSpanMs !== null && tokenSpanMs > 200
        ? (output / (tokenSpanMs / 1000)).toFixed(2)
        : null;
    const finalTps = largeEndLag ? wallTps : (tpsToLastDelta ?? wallTps);
    // Per-channel calibration from exact usage. Skipped on aborted/errored
    // (partial usage) and on out-of-range samples (truncation / unstreamed-
    // thinking guard — #12).
    const calibNotes: string[] = [];
    if (stopReason === 'aborted' || stopReason === 'error') {
      calibNotes.push(`skipped:stop=${stopReason}`);
    } else if (output !== undefined && output > 0) {
      const rest = output - reasoning; // text + tool tokens
      const updates: { ch: Channel; sample: number; tokens: number }[] = [];
      if (reasoning > 0 && chars.think > 100) {
        updates.push({ ch: 'think', sample: chars.think / reasoning, tokens: reasoning });
      }
      if (chars.text === 0 && chars.tool > 100 && rest > 0) {
        updates.push({ ch: 'tool', sample: chars.tool / rest, tokens: rest });
      } else if (chars.tool === 0 && chars.text > 100 && rest > 0) {
        updates.push({ ch: 'text', sample: chars.text / rest, tokens: rest });
      }
      if (updates.length === 0) calibNotes.push('skipped:mixed-or-thin');
      for (const u of updates) {
        if (u.sample < RATIO_MIN || u.sample > RATIO_MAX) {
          calibNotes.push(`${u.ch}:out-of-range ${round2(u.sample)}`);
          continue;
        }
        ratios[u.ch] = emaStep(ratios[u.ch], u.sample, u.tokens);
      }
      // Live-estimate correction k (display-level): EMA of exact/raw
      // estimate. Skipped when the live display already ran on exact
      // usage (rawEst is then meaningless) or on thin calls (noisy).
      if (lastLive !== null && !lastLive.exact && lastLive.estTokens >= 100) {
        const kSample = Math.min(BIAS_MAX, Math.max(BIAS_MIN, output / lastLive.estTokens));
        liveBias = liveBias * (1 - BIAS_ALPHA) + kSample * BIAS_ALPHA;
      }
      saveModelState(modelKey, ratios, liveBias, statePath);
    }
    log({
      ev: 'message_end',
      role: 'assistant',
      stopReason,
      usage,
      serverUsage:
        lastLoggedUsage !== null ? (JSON.parse(lastLoggedUsage) as Record<string, unknown>) : null,
      lastLive,
      ch: { ...chars },
      deltaCount,
      ttftMs: firstTokenMs !== null && anchorMs() ? firstTokenMs - anchorMs() : null,
      streamMs,
      tokenSpanMs,
      endLagMs,
      largeEndLag,
      tpsToLastDelta,
      finalTps,
      calib: calibNotes.length > 0 ? calibNotes.join(' ') : 'ok',
      ratios: { think: round2(ratios.think), text: round2(ratios.text), tool: round2(ratios.tool) },
      bias: round2(liveBias),
    });
    if (finalTps !== null && firstTokenMs !== null && anchorMs()) {
      ctx.ui.setWorkingMessage(
        `Working... TTFT ${fmtSeconds(firstTokenMs - anchorMs())} · ${finalTps} tok/s (final)`,
      );
      // Hold the readout so it is actually visible, then restore the
      // default line — unless a new LLM call starts first (its
      // before_provider_request already cancelled the timer).
      const seq = callSeq;
      clearFinal();
      finalClearTimer = setTimeout(() => {
        finalClearTimer = null;
        if (callSeq === seq) activeCtx?.ui.setWorkingMessage(undefined);
      }, FINAL_HOLD_MS);
    } else {
      clearFinal();
      ctx.ui.setWorkingMessage(undefined); // no readout — restore now
    }
  });

  pi.on('agent_end', (_event, _ctx) => {
    clearStall();
    clearFinal();
    log({ ev: 'agent_end' });
  });

  pi.on('session_shutdown', (_event, _ctx) => {
    clearStall();
    clearFinal();
    log({ ev: 'session_shutdown' });
  });
}
