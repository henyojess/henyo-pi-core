import { describe, it, expect } from "vitest";
import { createParseRootStringMiddleware } from "../../../src/tool-repair/middleware/parseRootString.js";

describe("parseRootString middleware", () => {
  const mw = createParseRootStringMiddleware();

  it("returns { changed: false } for normal input", () => {
    const input: Record<string, unknown> = { path: "/file.txt", edits: [] };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("parses a JSON-stringified root object", () => {
    const input: Record<string, unknown> = {
      path: '{"edits":[{"oldText":"a","newText":"b"}]}',
    };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(true);
    expect((input as any).path).toBeUndefined();
    expect((input as any).edits).toEqual([{ oldText: "a", newText: "b" }]);
  });

  it("returns { changed: false } for non-JSON string", () => {
    const input: Record<string, unknown> = { path: "not json" };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("returns { changed: false } for multi-key input", () => {
    const input: Record<string, unknown> = {
      a: '{"b": 1}',
      c: "value",
    };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });

  it("returns { changed: false } for array string", () => {
    const input: Record<string, unknown> = { path: '["a","b"]' };
    const result = mw(input, { toolName: "edit", schema: {} as any });
    expect(result.changed).toBe(false);
  });
});
