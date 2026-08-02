import { describe, it, expect } from "vitest";
import { extractPathMiddleware } from "../../../src/tool-repair/middleware/extractPath.js";

describe("extractPath middleware", () => {
  it("returns { changed: false } when no edits array", () => {
    const input: Record<string, unknown> = { path: "/f.txt" };
    const result = extractPathMiddleware(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("returns { changed: false } when path already at top level", () => {
    const input: Record<string, unknown> = {
      path: "/f.txt",
      edits: [{ oldText: "a", newText: "b" }],
    };
    const result = extractPathMiddleware(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("extracts path from edits[0] to top level", () => {
    const input: Record<string, unknown> = {
      edits: [
        { path: "/file.txt", oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    };
    const result = extractPathMiddleware(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect((input as any).path).toBe("/file.txt");
    expect((input as any).edits[0].path).toBeUndefined();
    expect((input as any).edits[1].path).toBeUndefined();
  });

  it("returns { changed: false } when edits[0].path is not a string", () => {
    const input: Record<string, unknown> = {
      edits: [{ oldText: "a", newText: "b" }],
    };
    const result = extractPathMiddleware(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("returns { changed: false } when edits[0] is not an object", () => {
    const input: Record<string, unknown> = {
      edits: ["not an object"],
    };
    const result = extractPathMiddleware(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("returns note with tool name", () => {
    const input: Record<string, unknown> = {
      edits: [{ path: "/f.txt", oldText: "a" }],
    };
    const result = extractPathMiddleware(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect(result.note).toContain("Extracted path");
  });
});
