import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock @earendil-works/pi-coding-agent since it's resolved at runtime by pi
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    create: vi.fn((cwd: string) => ({
      getSessionFile: () => join(cwd, ".pi", "sessions", `session-${Date.now()}.json`),
      getSessionId: () => `test-session-${Math.random().toString(36).slice(2)}`,
      getSessionDir: () => join(cwd, ".pi", "sessions"),
      getHeader: () => ({
        type: "session" as const,
        version: 3,
        id: `test-session-${Math.random().toString(36).slice(2)}`,
        timestamp: new Date().toISOString(),
        cwd,
      }),
      writeSession: vi.fn(),
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
      switchSession: vi.fn(() => Promise.resolve({ cancelled: false })),
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
      switchSession: vi.fn(() => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler("/definitely/nonexistent/path", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Path not found: /definitely/nonexistent/path", "error");
  });

  it("skips mkdir when session directory already exists", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const testCwd = join(tmpdir(), `cwd-existing-${Date.now()}`);
    mkdirSync(testCwd, { recursive: true });

    const targetDir = join(tmpdir(), `cwd-existing-target-${Date.now()}`);
    const sessionDir = join(targetDir, ".pi", "sessions");
    mkdirSync(sessionDir, { recursive: true }); // pre-create the directory

    const ctx = {
      cwd: testCwd,
      ui: { notify: vi.fn() },
      switchSession: vi.fn((_file: string, opts?: { withSession?: Function }) => {
        if (opts?.withSession) {
          opts.withSession({ ui: ctx.ui, cwd: targetDir });
        }
        return Promise.resolve({ cancelled: false });
      }),
    };

    await capturedCommand!.opts.handler(targetDir, ctx as any);

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
        switchSession: vi.fn(() => Promise.resolve({ cancelled: false })),
      };

      await capturedCommand!.opts.handler(fileName, ctx as any);

      expect(ctx.ui.notify).toHaveBeenCalledWith(`Not a directory: ${tmpFile}`, "error");
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });

  it("handles directory switch and calls switchSession", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const testCwd = join(tmpdir(), `cwd-test-cwd-${Date.now()}`);
    mkdirSync(testCwd, { recursive: true });

    const targetDir = join(tmpdir(), `cwd-target-${Date.now()}`);
    mkdirSync(targetDir, { recursive: true });

    let sessionFilePassed: string | null = null;
    const ctx = {
      cwd: testCwd,
      ui: { notify: vi.fn() },
      switchSession: vi.fn((file: string, opts?: { withSession?: Function }) => {
        sessionFilePassed = file;
        // Invoke the withSession callback if provided (mimicking real pi behavior)
        // In reality, switchSession provides a new context with the target CWD from the session header
        if (opts?.withSession) {
          opts.withSession({ ui: ctx.ui, cwd: targetDir });
        }
        return Promise.resolve({ cancelled: false });
      }),
    };

    await capturedCommand!.opts.handler(targetDir, ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith(`Now in: ${targetDir}`, "info");
    expect(ctx.switchSession).toHaveBeenCalledTimes(1);
    expect(sessionFilePassed).toContain(targetDir);

    // Cleanup
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(testCwd, { recursive: true, force: true });
  });

  it("shows cancelled message when session switch is cancelled", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const testCwd = join(tmpdir(), `cwd-test-cancel-${Date.now()}`);
    mkdirSync(testCwd, { recursive: true });

    const targetDir = join(tmpdir(), `cwd-target-cancel-${Date.now()}`);
    mkdirSync(targetDir, { recursive: true });

    const ctx = {
      cwd: testCwd,
      ui: { notify: vi.fn() },
      switchSession: vi.fn((_file: string, opts?: { withSession?: Function }) => {
        if (opts?.withSession) {
          opts.withSession({ ui: ctx.ui, cwd: targetDir });
        }
        return Promise.resolve({ cancelled: true });
      }),
    };

    await capturedCommand!.opts.handler(targetDir, ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Session switch cancelled", "info");

    // Cleanup
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(testCwd, { recursive: true, force: true });
  });

  it("handles SessionManager returning null sessionFile", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    // Re-mock SessionManager for this specific test
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    vi.spyOn(SessionManager, "create").mockReturnValueOnce({
      getSessionFile: () => null as unknown as string,
      getSessionId: () => "test-session-null",
      getSessionDir: () => "/tmp/.pi/sessions",
      getHeader: () => ({}),
      writeSession: vi.fn(),
    });

    const testCwd = join(tmpdir(), `cwd-test-${Date.now()}`);
    mkdirSync(testCwd, { recursive: true });

    const targetDir = join(tmpdir(), `cwd-null-target-${Date.now()}`);
    mkdirSync(targetDir, { recursive: true });

    const ctx = {
      cwd: testCwd,
      ui: { notify: vi.fn() },
      switchSession: vi.fn(() => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler(targetDir, ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Failed to create new session", "error");

    // Cleanup
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(testCwd, { recursive: true, force: true });
  });

  it("handles invalid path relative to cwd", async () => {
    cwdCommand(createMockPi() as any);
    expect(capturedCommand).not.toBeNull();

    const ctx = {
      cwd: "/root/workspace",
      ui: { notify: vi.fn() },
      switchSession: vi.fn(() => Promise.resolve({ cancelled: false })),
    };

    await capturedCommand!.opts.handler("../nonexistent-dir-xyz", ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Path not found: /root/nonexistent-dir-xyz", "error");
  });
});