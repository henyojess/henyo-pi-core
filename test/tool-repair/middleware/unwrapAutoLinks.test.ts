import { describe, it, expect } from "vitest";
import { createUnwrapAutoLinksMiddleware } from "../../../src/tool-repair/middleware/unwrapAutoLinks.js";

describe("unwrapAutoLinks middleware", () => {
  const mw = createUnwrapAutoLinksMiddleware(["path", "file_path"]);

  it("returns { changed: false } when no auto-links present", () => {
    const input: Record<string, unknown> = { path: "/normal/path.txt" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("unwraps degenerate auto-link [text](http://text)", () => {
    const input: Record<string, unknown> = { path: "[notes.md](http://notes.md)" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect((input as any).path).toBe("notes.md");
    expect(result.note).toContain("Unwrapped markdown auto-link");
  });

  it("does NOT unwrap real markdown links", () => {
    const input: Record<string, unknown> = { path: "[Notes](http://example.com/notes.md)" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
    expect((input as any).path).toBe("[Notes](http://example.com/notes.md)");
  });

  it("handles multiple path fields", () => {
    const input: Record<string, unknown> = {
      path: "[a.md](http://a.md)",
      file_path: "[b.md](http://b.md)",
    };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect((input as any).path).toBe("a.md");
    expect((input as any).file_path).toBe("b.md");
  });

  it("skips non-string fields", () => {
    const input: Record<string, unknown> = { path: 123 };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("skips fields not in the provided list", () => {
    const input: Record<string, unknown> = { other: "[x.md](http://x.md)" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
    expect((input as any).other).toBe("[x.md](http://x.md)");
  });
});
