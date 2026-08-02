import { describe, it, expect } from "vitest";
import { createParseStringifiedMiddleware } from "../../../src/tool-repair/middleware/parseStringified.js";

describe("parseStringified middleware", () => {
  const mw = createParseStringifiedMiddleware(["array", "object"]);

  it("returns { changed: false } when no issues", () => {
    const input: Record<string, unknown> = { path: "/f.txt", edits: [] };
    const result = mw(input, { toolName: "edit", schema: {} as any, issues: [] });
    expect(result.changed).toBe(false);
  });

  it("parses JSON-stringified array at issue site", () => {
    const input: Record<string, unknown> = { path: "/f.txt", edits: '["a","b"]' };
    const issues = [
      {
        keyword: "type",
        instancePath: "/edits",
        params: { type: "array" },
        message: "expected array",
      },
    ];
    const result = mw(input, { toolName: "edit", schema: {} as any, issues });
    expect(result.changed).toBe(true);
    expect((input as any).edits).toEqual(["a", "b"]);
  });

  it("parses JSON-stringified object at issue site", () => {
    const input: Record<string, unknown> = { path: "/f.txt", options: '{"validate":true}' };
    const issues = [
      {
        keyword: "type",
        instancePath: "/options",
        params: { type: "object" },
        message: "expected object",
      },
    ];
    const result = mw(input, { toolName: "edit", schema: {} as any, issues });
    expect(result.changed).toBe(true);
    expect((input as any).options).toEqual({ validate: true });
  });

  it("handles nested issue sites", () => {
    const input: Record<string, unknown> = {
      path: "/f.txt",
      edits: [{ tags: '["a","b"]' }],
    };
    const issues = [
      {
        keyword: "type",
        instancePath: "/edits/0/tags",
        params: { type: "array" },
        message: "expected array",
      },
    ];
    const result = mw(input, { toolName: "edit", schema: {} as any, issues });
    expect(result.changed).toBe(true);
    expect((input as any).edits[0].tags).toEqual(["a", "b"]);
  });

  it("does NOT parse non-matching types", () => {
    const input: Record<string, unknown> = { path: '["a","b"]' };
    const issues = [
      {
        keyword: "type",
        instancePath: "/path",
        params: { type: "string" },
        message: "expected string",
      },
    ];
    const result = mw(input, { toolName: "edit", schema: {} as any, issues });
    expect(result.changed).toBe(false);
  });

  it("handles Python-style array syntax", () => {
    const input: Record<string, unknown> = { path: "/f.txt", tags: "{'a': 1, 'b': 2}" };
    const issues = [
      {
        keyword: "type",
        instancePath: "/tags",
        params: { type: "object" },
        message: "expected object",
      },
    ];
    const result = mw(input, { toolName: "edit", schema: {} as any, issues });
    // Python-style should be converted and parsed
    expect(result.changed).toBe(true);
  });
});
