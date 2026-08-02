import { describe, it, expect } from "vitest";
import { createRenameAliasesMiddleware } from "../../../src/tool-repair/middleware/renameAliases.js";

describe("renameAliases middleware", () => {
  const aliases: Record<string, readonly string[]> = {
    path: ["file_path", "filePath"],
    oldText: ["old_text", "oldText"],
  };
  const mw = createRenameAliasesMiddleware(aliases);

  it("returns { changed: false } when no aliases present", () => {
    const input: Record<string, unknown> = { path: "/file.txt", oldText: "a" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("renames file_path to path", () => {
    const input: Record<string, unknown> = { file_path: "/file.txt", oldText: "a" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect((input as any).path).toBe("/file.txt");
    expect((input as any).file_path).toBeUndefined();
  });

  it("renames old_text to oldText", () => {
    const input: Record<string, unknown> = { path: "/f.txt", old_text: "a" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect((input as any).oldText).toBe("a");
    expect((input as any).old_text).toBeUndefined();
  });

  it("does NOT rename when canonical field already has value", () => {
    const input: Record<string, unknown> = { path: "/correct.txt", file_path: "/wrong.txt" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
    expect((input as any).path).toBe("/correct.txt");
    expect((input as any).file_path).toBe("/wrong.txt");
  });

  it("skips null/empty alias values", () => {
    const input: Record<string, unknown> = { path: "/f.txt", file_path: null, oldText: "a" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("returns note with renamed field info", () => {
    const input: Record<string, unknown> = { filePath: "/f.txt" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect(result.note).toContain("Renamed");
    expect(result.note).toContain("filePath");
    expect(result.note).toContain("path");
  });

  it("does NOT rename nested fields (only top-level)", () => {
    const input: Record<string, unknown> = {
      path: "/f.txt",
      edits: [{ old_text: "a", new_text: "b" }],
    };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    // Nested fields are NOT renamed by this middleware (issue sites handle that)
    expect(result.changed).toBe(false);
  });
});
