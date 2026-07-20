import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock @earendil-works/pi-coding-agent since it's resolved at runtime by pi
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    inMemory: vi.fn((cwd?: string) => ({
      getSessionId: () => `test-session-${Math.random().toString(36).slice(2)}`,
      getSessionFile: () => undefined,
      getSessionDir: () => join(cwd || "/tmp", ".pi", "sessions"),
    })),
  },
}));

import cwdCommand from "../../src/commands/cwd";

describe("cwd command", () => {
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

  it("registers the /cwd command with correct metadata", () => {
    cwdCommand(createMockPi() as any);

    expect(capturedCommand).not.toBeNull();
    expect(capturedCommand!.name).toBe("cwd");
    expect(capturedCommand!.opts.description).toContain("Switch to another project directory");
  });

  it("shows current CWD when called without args", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const ctx = {
      cwd: "/some/path",
      ui: { notify: vi.fn() },
      newSession: vi.fn((_opts?: { setup?: Function; withSession?: Function }) => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler("", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("CWD: /some/path", "info");
  });

  it("shows error for non-existent path", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const ctx = {
      cwd: process.cwd(),
      ui: { notify: vi.fn() },
      newSession: vi.fn((_opts?: { setup?: Function; withSession?: Function }) => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler("/definitely/nonexistent/path", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Path not found: /definitely/nonexistent/path", "error");
  });

  it("calls newSession with setup and withSession callbacks", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const testCwd = join(tmpdir(), `cwd-test-cwd-${Date.now()}`);
    mkdirSync(testCwd, { recursive: true });

    const targetDir = join(tmpdir(), `cwd-target-${Date.now()}`);
    mkdirSync(targetDir, { recursive: true });

    const ctx = {
      cwd: testCwd,
      ui: { notify: vi.fn() },
      newSession: vi.fn((opts?: { setup?: Function; withSession?: Function }) => {
        // Invoke withSession if provided (mimicking real pi behavior)
        if (opts?.withSession) {
          opts.withSession({ ui: ctx.ui, cwd: targetDir });
        }
        return Promise.resolve({ cancelled: false });
      }),
    };

    await capturedCommand!.opts.handler(targetDir, ctx as any);

    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    expect(ctx.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.any(Function),
        withSession: expect.any(Function),
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(`Now in: ${targetDir}`, "info");

    // Cleanup
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(testCwd, { recursive: true, force: true });
  });

  it("shows error for path that is a file, not a directory", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const fileName = `cwd-test-file-${process.pid}.txt`;
    const tmpFile = join(tmpdir(), fileName);
    writeFileSync(tmpFile, "test content");

    try {
      const ctx = {
        cwd: tmpdir(),
        ui: { notify: vi.fn() },
        newSession: vi.fn((_opts?: { setup?: Function; withSession?: Function }) => Promise.resolve({ cancelled: false })),
      };

      await capturedCommand!.opts.handler(fileName, ctx as any);

      expect(ctx.ui.notify).toHaveBeenCalledWith(`Not a directory: ${tmpFile}`, "error");
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });

  it("handles directory switch and calls newSession", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const testCwd = join(tmpdir(), `cwd-test-cwd-${Date.now()}`);
    mkdirSync(testCwd, { recursive: true });

    const targetDir = join(tmpdir(), `cwd-target-${Date.now()}`);
    mkdirSync(targetDir, { recursive: true });

    const ctx = {
      cwd: testCwd,
      ui: { notify: vi.fn() },
      newSession: vi.fn((opts?: { setup?: Function; withSession?: Function }) => {
        // Invoke withSession if provided (mimicking real pi behavior)
        if (opts?.withSession) {
          opts.withSession({ ui: ctx.ui, cwd: targetDir });
        }
        return Promise.resolve({ cancelled: false });
      }),
    };

    await capturedCommand!.opts.handler(targetDir, ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith(`Now in: ${targetDir}`, "info");
    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    expect(ctx.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: expect.any(Function),
        withSession: expect.any(Function),
      }),
    );

    // Cleanup
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(testCwd, { recursive: true, force: true });
  });

  it("shows cancelled message when newSession is cancelled", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const testCwd = join(tmpdir(), `cwd-test-cancel-${Date.now()}`);
    mkdirSync(testCwd, { recursive: true });

    const targetDir = join(tmpdir(), `cwd-target-cancel-${Date.now()}`);
    mkdirSync(targetDir, { recursive: true });

    const ctx = {
      cwd: testCwd,
      ui: { notify: vi.fn() },
      newSession: vi.fn((_opts?: { setup?: Function; withSession?: Function }) => {
        return Promise.resolve({ cancelled: true });
      }),
    };

    await capturedCommand!.opts.handler(targetDir, ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Session switch cancelled", "info");
    expect(ctx.newSession).toHaveBeenCalledTimes(1);

    // Cleanup
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(testCwd, { recursive: true, force: true });
  });

  // Note: The "null sessionFile" test was removed — we no longer create session files
  // or call SessionManager.create() in /cwd. The session is now in-memory only.

  it("handles invalid path relative to cwd", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const ctx = {
      cwd: "/root/workspace",
      ui: { notify: vi.fn() },
      newSession: vi.fn((_opts?: { setup?: Function; withSession?: Function }) => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler("../nonexistent-dir-xyz", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Path not found: ../nonexistent-dir-xyz", "error");
  });
});