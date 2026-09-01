import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ttftTokpsExtension, type TtftTokpsOptions } from '../src/ttft-tokps';

// Mock @earendil-works/pi-coding-agent (ttft-tokps calls getAgentDir() at
// factory time only when statePath is not injected — all scenarios below
// inject an explicit tmp path; the mock keeps the default-path case safe).
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => join(tmpHome, '.pi', 'agent'),
}));

const tmpHome = mkdtempSync(join(tmpdir(), `ttft-home-${Math.random().toString(36).slice(2, 8)}`));

// ---------- fake monotonic clock ----------
// The extension reads performance.now() (monotonic) for all timing. The
// harness shadowed the property on globalThis.performance; in vitest we spy
// the global. Real timers stay REAL: the stall scenario needs the actual
// 500 ms ticker (same as the harness).
let fakeNow = 0;
const perfNowSpy = vi
  .spyOn(performance, 'now')
  .mockImplementation(() => fakeNow);

/** Harness-shaped fake pi: one handler slot per event. */
function createStubPi() {
  const handlers: Record<string, (event: any, ctx: any) => void> = {};
  return {
    handlers,
    on(name: string, fn: (event: any, ctx: any) => void) {
      handlers[name] = fn;
      return () => delete handlers[name];
    },
    getThinkingLevel: () => 'off',
  };
}

/** Fresh tmp state dir + log file per scenario (deterministic seeds). */
function makeEnv(opts: Partial<TtftTokpsOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `ttft-scenario-${Math.random().toString(36).slice(2, 8)}`));
  const statePath = join(dir, 'state.json');
  const logFile = join(dir, 'debug.log');
  const msgs: (string | undefined)[] = [];
  const stub = createStubPi();
  ttftTokpsExtension(stub as any, {
    statePath,
    logFile,
    ...opts,
  });
  const ctx = {
    model: { provider: 'test', id: 'm' },
    ui: { setWorkingMessage: (m: string | undefined) => msgs.push(m) },
  };
  const strMsgs = (from: number) => msgs.slice(from).filter((m): m is string => typeof m === 'string');
  return { dir, statePath, logFile, stub, ctx, msgs, strMsgs };
}

/** Harness `beginCall` (fresh fake time origin 1000 — 0 would read as "no anchor"). */
function beginCall(env: ReturnType<typeof makeEnv>, t = 1000) {
  fakeNow = t;
  env.stub.handlers['agent_start']({}, env.ctx);
  env.stub.handlers['before_provider_request']({}, env.ctx);
  env.stub.handlers['message_start']({ message: { role: 'assistant' } }, env.ctx);
}

function delta(
  env: ReturnType<typeof makeEnv>,
  type: 'thinking_delta' | 'text_delta' | 'toolcall_delta',
  nChars: number,
  t: number,
  partialExtra: Record<string, unknown> = {},
) {
  fakeNow = t;
  env.stub.handlers['message_update'](
    {
      assistantMessageEvent: {
        type,
        delta: 'x'.repeat(nChars),
        partial: { content: [], ...partialExtra },
      },
    },
    env.ctx,
  );
}

function endCall(
  env: ReturnType<typeof makeEnv>,
  t: number,
  usage: { output: number; reasoning?: number },
  stopReason = 'stop',
) {
  fakeNow = t;
  env.stub.handlers['message_end']({ message: { role: 'assistant', stopReason, usage } }, env.ctx);
}

/** Cleanup path the extension provides: clears stall + final-hold timers. */
function cleanup(env: ReturnType<typeof makeEnv>) {
  env.stub.handlers['agent_end']({}, env.ctx);
  env.stub.handlers['session_shutdown']({}, env.ctx);
}

const readState = (statePath: string) => JSON.parse(readFileSync(statePath, 'utf8'));

/** Parse a JSONL trace file (empty when the file doesn't exist). */
function readLogLines(logFile: string): Record<string, any>[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** One trace-on scenario with ≥ 25 deltas so a `sample` line is emitted. */
function sampleScenario(env: ReturnType<typeof makeEnv>) {
  beginCall(env);
  for (let i = 0; i < 30; i++) delta(env, 'text_delta', 40, 2000 + i * 100); // last delta t=4900
  endCall(env, 5000, { output: 500, reasoning: 0 }); // span 2.9s → 172.41 tok/s (final)
  cleanup(env);
}

// ---------- trace logging: off by default, on + rotation + audit contract ----------
describe('trace logging', () => {
  it('off by default (explicit false AND omitted): no log file, no rotation artifacts', () => {
    for (const opts of [{ traceEnabled: false }, {}]) {
      const env = makeEnv(opts);
      sampleScenario(env); // would emit ~27 lines if tracing were on
      expect(existsSync(env.logFile)).toBe(false);
      // No rotated artifacts either — nothing may exist under the log name.
      const files = readdirSync(env.dir);
      expect(files.some((f) => f.startsWith('debug.log'))).toBe(false);
      expect(existsSync(env.statePath)).toBe(true); // state calibration is unaffected
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('on: JSONL lines per fired event, incl. turn_start / sample / message_end', () => {
    const env = makeEnv({ traceEnabled: true });
    beginCall(env);
    env.stub.handlers['turn_start']({}, env.ctx); // fire the log-only handler explicitly
    for (let i = 0; i < 30; i++) delta(env, 'text_delta', 40, 2000 + i * 100);
    endCall(env, 5000, { output: 500, reasoning: 0 });
    cleanup(env);
    const lines = readLogLines(env.logFile);
    const evs = new Set(lines.map((l) => l.ev));
    for (const ev of ['init', 'agent_start', 'turn_start', 'before_provider_request', 'message_start', 'first_token', 'sample', 'message_end']) {
      expect(evs.has(ev)).toBe(true); // ≥ 1 line per fired event
    }
    expect(lines.filter((l) => l.ev === 'turn_start').length).toBe(1);
    expect(lines.filter((l) => l.ev === 'sample').length).toBe(1); // 30 deltas → sample at 25
    expect(lines.filter((l) => l.ev === 'message_end').length).toBe(1);
    // Every line carries the timestamp envelope (ts + iso) prepended by log().
    for (const l of lines) {
      expect(typeof l.ts).toBe('number');
      expect(typeof l.iso).toBe('string');
    }
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('audit contract: sample.displayed.tps is the exact displayed string; message_end carries lastLive/finalTps/tpsToLastDelta/usage.output', () => {
    const env = makeEnv({ traceEnabled: true });
    const msgs0 = env.msgs.length;
    beginCall(env);
    for (let i = 0; i < 30; i++) delta(env, 'text_delta', 40, 2000 + i * 100);
    endCall(env, 5000, { output: 500, reasoning: 0 });
    cleanup(env);
    const lines = readLogLines(env.logFile);
    const sample = lines.find((l) => l.ev === 'sample');
    const endLine = lines.find((l) => l.ev === 'message_end');
    expect(sample).toBeDefined();
    expect(endLine).toBeDefined();

    // sample.displayed.tps must match an exact displayed working message.
    const displayedTps: string = sample.displayed.tps;
    expect(displayedTps).toMatch(/^≈[\d.]+ tok\/s$/);
    const liveMsgs = env.strMsgs(msgs0).filter((m) => m.includes('· '));
    expect(liveMsgs.some((m) => m.endsWith(`· ${displayedTps}`))).toBe(true);

    // message_end fields (assertion #8 — the live-vs-final audit contract).
    expect(endLine.lastLive).not.toBeNull();
    expect(typeof endLine.lastLive.tps).toBe('string');
    expect(typeof endLine.finalTps).toBe('string');
    expect(typeof endLine.tpsToLastDelta).toBe('string');
    expect(typeof endLine.usage.output).toBe('number');
    // Live-vs-final error is computable straight from the log.
    const lastLiveNum = Number.parseFloat(endLine.lastLive.tps.replace('≈', ''));
    const finalNum = Number.parseFloat(endLine.finalTps);
    const err = Math.abs(lastLiveNum - finalNum) / finalNum;
    expect(Number.isFinite(err)).toBe(true);
    expect(err).toBeLessThan(1); // sanity: this scenario's estimate is close
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('rotation: maxBackups=2 → .1 and .2 exist, .3 does not; no data silently lost', () => {
    const env = makeEnv({ traceEnabled: true, maxLogBytes: 4096, maxBackups: 2 });
    beginCall(env);
    for (let i = 0; i < 1000; i++) delta(env, 'text_delta', 10, 2000 + i * 10); // 40 samples
    endCall(env, 12100, { output: 4000, reasoning: 0 });
    cleanup(env);
    expect(existsSync(env.logFile)).toBe(true);
    expect(existsSync(`${env.logFile}.1`)).toBe(true);
    expect(existsSync(`${env.logFile}.2`)).toBe(true);
    expect(existsSync(`${env.logFile}.3`)).toBe(false);
    // Main log never exceeds cap + one line (rotation runs before the append
    // that would push it past the cap).
    expect(statSync(env.logFile).size).toBeLessThan(4096 + 1024);
    // Total lines across the 3 files ≈ lines written: init + agent_start +
    // before_provider_request + message_start + first_token (5) + 40 samples
    // + message_end (1) = 46 (turn_start is not fired in this scenario).
    // Lines are lost only when a rotation overwrites the oldest backup:
    // the 3 files form a sliding window of ~2×(cap/avg line) lines
    // (measured: 30 of 46 for this workload). The range below distinguishes
    // "most data retained" from "rotation silently dropped everything".
    const total =
      readLogLines(env.logFile).length +
      readLogLines(`${env.logFile}.1`).length +
      readLogLines(`${env.logFile}.2`).length;
    expect(total).toBeGreaterThanOrEqual(25);
    expect(total).toBeLessThanOrEqual(46);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('per-model isolation: two modelKeys on one statePath → independent ratios + bias entries', () => {
    const env = makeEnv();
    // alpha/one: text-heavy, k gate passed (est ≥ 100) → bias moves off 1.0.
    beginCall(env);
    const ctxA = { model: { provider: 'alpha', id: 'one' }, ui: { setWorkingMessage: () => {} } };
    fakeNow = 1000;
    env.stub.handlers['agent_start']({}, ctxA);
    env.stub.handlers['before_provider_request']({}, ctxA);
    env.stub.handlers['message_start']({ message: { role: 'assistant' } }, ctxA);
    for (let i = 0; i < 10; i++) {
      fakeNow = 2000 + i * 200;
      env.stub.handlers['message_update'](
        { assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(50), partial: { content: [] } } },
        ctxA,
      );
    }
    fakeNow = 4200;
    env.stub.handlers['message_end'](
      { message: { role: 'assistant', stopReason: 'stop', usage: { output: 400, reasoning: 0 } } },
      ctxA,
    );
    // beta/two: tool-only, thin (below k gate) → bias stays neutral 1.0.
    const ctxB = { model: { provider: 'beta', id: 'two' }, ui: { setWorkingMessage: () => {} } };
    fakeNow = 10000;
    env.stub.handlers['agent_start']({}, ctxB);
    env.stub.handlers['before_provider_request']({}, ctxB);
    env.stub.handlers['message_start']({ message: { role: 'assistant' } }, ctxB);
    for (let i = 0; i < 6; i++) {
      fakeNow = 11000 + i * 200;
      env.stub.handlers['message_update'](
        { assistantMessageEvent: { type: 'toolcall_delta', delta: 'x'.repeat(50), partial: { content: [] } } },
        ctxB,
      );
    }
    fakeNow = 12300;
    env.stub.handlers['message_end'](
      { message: { role: 'assistant', stopReason: 'stop', usage: { output: 60, reasoning: 0 } } },
      ctxB,
    );
    cleanup(env);
    const st = readState(env.statePath);
    expect(st.ratios).toHaveProperty('alpha/one');
    expect(st.ratios).toHaveProperty('beta/two');
    // alpha/one: text sample 500/400=1.25 < RATIO_MIN → ratio UNCHANGED (seed),
    // k gate: est = round(500/2.64)=189 ≥ 100 → kSample = 400/189 ≈ 2.12
    // clamps to BIAS_MAX 2.0 → bias = 0.8 + 2.0*0.2 = 1.2 (moves off 1.0).
    expect(st.ratios['alpha/one'].text).toBe(2.64); // out-of-range guard
    expect(st.bias['alpha/one']).toBeCloseTo(1.2, 9); // clamped k sample (float: 1.2000000000000002)
    // beta/two: tool sample 300/60=5.0 in range → tool ratio EMA-updated;
    // k gate: est = round(300/2.63)=114 ≥ 100 → bias also moves.
    expect(st.ratios['beta/two'].tool).toBeGreaterThan(2.63);
    expect(st.bias['beta/two']).toBeLessThan(1.0); // 0.8 + (60/114)*0.2
    // Independence: entries exist per key with distinct values.
    expect(st.bias['alpha/one']).not.toBe(st.bias['beta/two']);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('silent-fail: non-writable logFile → handlers never throw', () => {
    const dir = mkdtempSync(join(tmpdir(), `ttft-blocked-${Math.random().toString(36).slice(2, 8)}`));
    // A regular file as the parent dir → appendFileSync fails with ENOTDIR
    // (works regardless of uid; a read-only dir wouldn't stop root).
    const blockedParent = join(dir, 'blocked');
    writeFileSync(blockedParent, 'x', 'utf-8');
    const env = makeEnv({
      traceEnabled: true,
      statePath: join(dir, 'state.json'),
      logFile: join(blockedParent, 'sub', 'log'),
    });
    expect(() => {
      sampleScenario(env);
    }).not.toThrow();
    // Display worked end-to-end despite every log write failing.
    expect(env.strMsgs(0).some((m) => m.includes('tok/s (final)'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

afterEach(() => {
  perfNowSpy.mockClear();
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------- Call A: tool-dominated, per-channel accounting ----------
// Expected values copied from ~/.pi/agent/.ttft-tokps-harness.mjs (A-final,
// A-calib, A-bias).
describe('scenario A: tool-dominated call (harness A-final / A-calib / A-bias)', () => {
  it('A-final: tool span dominates → final `39.67 tok/s (final)` + `TTFT 1.00s`', () => {
    const env = makeEnv();
    const msgsA0 = env.msgs.length;
    beginCall(env);
    delta(env, 'thinking_delta', 50, 2000); // thinking 200 chars, t=2000–3000
    delta(env, 'thinking_delta', 50, 2350);
    delta(env, 'thinking_delta', 50, 2700);
    delta(env, 'thinking_delta', 50, 3000);
    for (const t of [4000, 5000, 5500, 6000, 7000, 8000]) delta(env, 'toolcall_delta', 90, t); // tool 540 chars, last delta t=8000
    endCall(env, 8100, { output: 238, reasoning: 50 });
    // span 6.0s (2000→8000), 238/6 = 39.667 → 39.67. If toolcall_delta were
    // ignored: span 1.0s → 238.00 — the assertion catches that regression.
    const finalA = env.strMsgs(msgsA0).find((m) => m.includes('tok/s (final)'));
    expect(finalA).toBeDefined();
    expect(finalA).toContain('39.67 tok/s (final)');
    expect(finalA).toContain('TTFT 1.00s');
    cleanup(env);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('A-calib: per-channel ratio EMA for test/m (think ∈ (3.62, 3.7), tool ∈ (2.65, 2.75))', () => {
    const env = makeEnv();
    beginCall(env);
    delta(env, 'thinking_delta', 50, 2000);
    delta(env, 'thinking_delta', 50, 2350);
    delta(env, 'thinking_delta', 50, 2700);
    delta(env, 'thinking_delta', 50, 3000);
    for (const t of [4000, 5000, 5500, 6000, 7000, 8000]) delta(env, 'toolcall_delta', 90, t);
    endCall(env, 8100, { output: 238, reasoning: 50 });
    // think sample 200/50=4.0, α=1−2^(−50/500)≈0.067 → r≈3.646
    // tool  sample 540/188=2.872, α=1−2^(−188/500)≈0.229 → r≈2.686
    // (expected ranges copied from the harness — not re-derived)
    const stA = readState(env.statePath);
    expect(stA.v).toBe(2);
    const rm = stA.ratios?.['test/m'];
    expect(rm).toBeDefined();
    expect(rm.think).toBeGreaterThan(3.62);
    expect(rm.think).toBeLessThan(3.7);
    expect(rm.tool).toBeGreaterThan(2.65);
    expect(rm.tool).toBeLessThan(2.75);
    expect(rm.text).toBe(2.64); // untouched channel keeps the seed
    cleanup(env);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('A-bias: k ≈ 0.982 stored under state.bias["test/m"]; a second model key is independent', () => {
    const env = makeEnv();
    beginCall(env);
    delta(env, 'thinking_delta', 50, 2000);
    delta(env, 'thinking_delta', 50, 2350);
    delta(env, 'thinking_delta', 50, 2700);
    delta(env, 'thinking_delta', 50, 3000);
    for (const t of [4000, 5000, 5500, 6000, 7000, 8000]) delta(env, 'toolcall_delta', 90, t);
    endCall(env, 8100, { output: 238, reasoning: 50 });
    // raw est = round(200/3.62 + 540/2.63) = 261 → k = 0.8 + (238/261)*0.2 ≈ 0.982
    const stA = readState(env.statePath);
    const kA = stA.bias?.['test/m'];
    expect(typeof kA).toBe('number');
    // Exact k per the harness's derivation (asserted to 1e-9).
    expect(kA).toBeCloseTo(0.8 + (238 / 261) * 0.2, 9);
    expect(kA).toBeGreaterThan(0.95);
    expect(kA).toBeLessThan(1.0);

    // Second model key on the SAME state file: independent entry, neutral k
    // (1.0 — its call is below the raw-est ≥ 100 gate so k is not updated).
    const ctx2 = { model: { provider: 'test', id: 'm2' }, ui: { setWorkingMessage: () => {} } };
    fakeNow = 10000;
    env.stub.handlers['agent_start']({}, ctx2);
    env.stub.handlers['before_provider_request']({}, ctx2);
    env.stub.handlers['message_start']({ message: { role: 'assistant' } }, ctx2);
    fakeNow = 11000;
    env.stub.handlers['message_update'](
      {
        assistantMessageEvent: {
          type: 'thinking_delta',
          delta: 'x'.repeat(30),
          partial: { content: [] },
        },
      },
      ctx2,
    );
    fakeNow = 11100;
    env.stub.handlers['message_end'](
      { message: { role: 'assistant', stopReason: 'stop', usage: { output: 10, reasoning: 5 } } },
      ctx2,
    );
    const stB = readState(env.statePath);
    expect(stB.ratios).toHaveProperty('test/m');
    expect(stB.ratios).toHaveProperty('test/m2');
    expect(stB.bias).toHaveProperty('test/m2');
    expect(stB.bias['test/m2']).toBe(1); // neutral start, gate not passed
    expect(stB.bias['test/m']).toBeCloseTo(0.8 + (238 / 261) * 0.2, 9); // untouched
    cleanup(env);
    rmSync(env.dir, { recursive: true, force: true });
  });
});

// ---------- Call B: exact usage path ----------
describe('scenario B: exact usage (harness B-exact)', () => {
  it('B-exact: mid-stream partial.usage.output=500 → live `≈125.00 tok/s`', () => {
    const env = makeEnv();
    const msgsB0 = env.msgs.length;
    beginCall(env, 10000);
    for (const t of [11000, 12000, 13000, 14000]) delta(env, 'text_delta', 8, t);
    delta(env, 'text_delta', 8, 15000, { usage: { output: 500, reasoning: 0 } }); // span 4.0s (11000→15000)
    endCall(env, 15100, { output: 500, reasoning: 0 });
    const liveB = env.strMsgs(msgsB0).find((m) => m.includes('≈125.00 tok/s') && !m.includes('(final)'));
    expect(liveB).toBeDefined();
    cleanup(env);
    rmSync(env.dir, { recursive: true, force: true });
  });
});

// ---------- Call C: display gate ----------
describe('scenario C: display gate (harness C-gate)', () => {
  it('C-gate: est < 50 tokens → every live message ends `· …`', () => {
    const env = makeEnv();
    const msgsC0 = env.msgs.length;
    beginCall(env, 20000);
    delta(env, 'thinking_delta', 10, 21000); // 30 chars total, span 3.0s, est ≈ 8 < 50
    delta(env, 'thinking_delta', 10, 23500);
    delta(env, 'thinking_delta', 10, 24000);
    endCall(env, 24100, { output: 10, reasoning: 8 });
    const liveC = env.strMsgs(msgsC0).filter((m) => m.includes('TTFT') && !m.includes('(final)'));
    expect(liveC.length).toBeGreaterThan(0);
    for (const m of liveC) expect(m.endsWith('· …')).toBe(true);
    cleanup(env);
    rmSync(env.dir, { recursive: true, force: true });
  });
});

// ---------- Call D: stall hold ----------
describe('scenario D: stall hold (harness D-stall)', () => {
  it('D-stall: 2 s quiet → hold + `…` written; nothing after message_end; agent_end clears timers', async () => {
    const env = makeEnv();
    const msgsD0 = env.msgs.length;
    beginCall(env, 30000);
    for (let i = 0; i < 10; i++) delta(env, 'thinking_delta', 30, 31000 + i * 300); // last delta t=33700, est ≈ 82 ≥ 50
    const lastLiveD = env
      .strMsgs(msgsD0)
      .filter((m) => m.includes('tok/s') && !m.includes('(final)'))
      .pop();
    expect(lastLiveD).toBeDefined();

    fakeNow = 35700; // +2000ms with no deltas (> 1500ms stall)
    await new Promise((r) => setTimeout(r, 1200)); // let ≥2 real 500ms ticks fire
    const stallMsgs = env.strMsgs(msgsD0).filter((m) => m.endsWith('tok/s …'));
    expect(stallMsgs.length).toBeGreaterThan(0);

    endCall(env, 36000, { output: 100, reasoning: 80 });
    const afterEnd = env.msgs.length; // after the (legitimate) final readout + default restore
    await new Promise((r) => setTimeout(r, 1100)); // 2+ tick intervals — cleared timer must not fire
    expect(env.msgs.length).toBe(afterEnd);

    // agent_end/session_shutdown exercise the extension's cleanup path
    // (clears the final-hold timer) — the harness relied on process.exit
    // here instead.
    cleanup(env);
    const afterCleanup = env.msgs.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(env.msgs.length).toBe(afterCleanup);
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('final hold: `tok/s (final)` readout restored to default after 5 s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const env = makeEnv();
      const msgs0 = env.msgs.length;
      const undefCount = () => env.msgs.filter((m) => m === undefined).length;
      beginCall(env); // before_provider_request resets the working line (undefined write)
      const base = undefCount();
      for (const t of [2000, 2500, 3000]) delta(env, 'text_delta', 30, t);
      endCall(env, 3100, { output: 100, reasoning: 0 }); // span 1.1s → 90.91 tok/s (final)
      const finalMsg = env.strMsgs(msgs0).find((m) => m.includes('tok/s (final)'));
      expect(finalMsg).toBeDefined();
      expect(undefCount()).toBe(base); // hold pending, not yet restored
      vi.advanceTimersByTime(5001);
      // The 5 s final-hold timer restores the default line (undefined write).
      expect(undefCount()).toBe(base + 1);
      cleanup(env);
      rmSync(env.dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('final hold: a new LLM call cancels the 5 s restore before it fires', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const env = makeEnv();
      const msgs0 = env.msgs.length;
      const undefCount = () => env.msgs.filter((m) => m === undefined).length;
      beginCall(env);
      const base = undefCount();
      for (const t of [2000, 2500, 3000]) delta(env, 'text_delta', 30, t);
      endCall(env, 3100, { output: 100, reasoning: 0 });
      expect(env.strMsgs(msgs0).some((m) => m.includes('tok/s (final)'))).toBe(true);
      expect(undefCount()).toBe(base);
      // Hold is pending…
      vi.advanceTimersByTime(2000);
      expect(undefCount()).toBe(base);
      // …until the next call takes over the working line (its own reset write,
      // and it cancels the pending final-hold timer).
      fakeNow = 4000;
      env.stub.handlers['before_provider_request']({}, env.ctx);
      const afterNewCall = undefCount();
      expect(afterNewCall).toBe(base + 1);
      vi.advanceTimersByTime(5000);
      expect(undefCount()).toBe(afterNewCall); // cancelled — no restore write
      cleanup(env);
      rmSync(env.dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
