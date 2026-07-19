import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @earendil-works/pi-coding-agent since it's resolved at runtime by pi
vi.mock("@earendil-works/pi-coding-agent");

import newpCommand from "./newp";

describe("newp command", () => {
  let capturedCommand: { name: string; opts: { description: string; handler: Function } } | null = null;

  const createMockPi = () => ({
    registerCommand(name: string, opts: { description: string; handler: Function }) {
      capturedCommand = { name, opts };
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCommand = null;
  });

  it("registers the /newp command with correct metadata", () => {
    newpCommand(createMockPi() as any);

    expect(capturedCommand).not.toBeNull();
    expect(capturedCommand!.name).toBe("newp");
    expect(capturedCommand!.opts.description).toContain("Start a new session");
  });

  it("shows usage message when called without args", async () => {
    newpCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const ctx = {
      ui: { notify: vi.fn() },
      newSession: vi.fn(() => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler("", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /newp <your prompt>", "error");
  });

  it("shows usage message when called with whitespace only", async () => {
    newpCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const ctx = {
      ui: { notify: vi.fn() },
      newSession: vi.fn(() => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler("   ", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /newp <your prompt>", "error");
  });

  it("starts a new session with the prompt", async () => {
    newpCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    let messageSent: string | null = null;

    const ctx = {
      ui: { notify: vi.fn() },
      newSession: vi.fn((opts?: { withSession?: Function }) => {
        if (opts?.withSession) {
          opts.withSession({
            sendUserMessage: async (msg: string) => { messageSent = msg; },
          });
        }
        return Promise.resolve({ cancelled: false });
      }),
    };

    const prompt = "Implement a fibonacci function in TypeScript";
    await capturedCommand!.opts.handler(prompt, ctx as any);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(messageSent).toBe(prompt);
  });

  it("passes prompt to the session's sendUserMessage", async () => {
    newpCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    let messageSent: string | null = null;

    const ctx = {
      ui: { notify: vi.fn() },
      newSession: vi.fn((opts?: { withSession?: Function }) => {
        if (opts?.withSession) {
          opts.withSession({
            sendUserMessage: async (msg: string) => { messageSent = msg; },
          });
        }
        return Promise.resolve({ cancelled: false });
      }),
    };

    const prompt = "Implement a fibonacci function in TypeScript";
    await capturedCommand!.opts.handler(prompt, ctx as any);

    expect(messageSent).toBe(prompt);
  });

  it("shows warning when session creation is cancelled", async () => {
    newpCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const ctx = {
      ui: { notify: vi.fn() },
      newSession: vi.fn((_opts?: { withSession?: Function }) => {
        return Promise.resolve({ cancelled: true });
      }),
    };

    await capturedCommand!.opts.handler("do something", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("New session was cancelled", "warning");
  });
});