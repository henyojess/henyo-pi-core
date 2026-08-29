import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
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
