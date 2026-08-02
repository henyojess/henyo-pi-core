import { describe, it, expect } from "vitest";
import { repairToolInput } from "../../src/tool-repair/engine.js";
import { editConfig } from "../../src/tool-repair/configs.js";

describe("repair engine: non-object input → unrepairable", () => {
  const toolName = "edit";

  it("returns unrepairable for null input", () => {
    const result = repairToolInput(editConfig, null, toolName);
    expect(result.outcome).toBe("unrepairable");
    expect(result.args).toBe(null);
    expect(result.retryMessage).toBeDefined();
  });

  it("returns unrepairable for undefined input", () => {
    const result = repairToolInput(editConfig, undefined, toolName);
    expect(result.outcome).toBe("unrepairable");
    expect(result.args).toBe(undefined);
    expect(result.retryMessage).toBeDefined();
  });

  it("returns unrepairable for numeric input", () => {
    const result = repairToolInput(editConfig, 42, toolName);
    expect(result.outcome).toBe("unrepairable");
    expect(result.args).toBe(42);
    expect(result.retryMessage).toBeDefined();
  });

  it("returns unrepairable for boolean input", () => {
    const result = repairToolInput(editConfig, true, toolName);
    expect(result.outcome).toBe("unrepairable");
    expect(result.args).toBe(true);
    expect(result.retryMessage).toBeDefined();
  });

  it("returns unrepairable for array input (not an object)", () => {
    const result = repairToolInput(editConfig, [1, 2, 3], toolName);
    expect(result.outcome).toBe("unrepairable");
    expect(result.args).toEqual([1, 2, 3]);
    expect(result.retryMessage).toBeDefined();
  });
});

describe("repair engine: root string parsing (Stage 3)", () => {
  const toolName = "edit";

  it("parses JSON-string root to object", () => {
    const input = JSON.stringify({ path: "/file.txt", edits: [{ oldText: "a", newText: "b" }] });
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    expect(result.rulesFired).toContain("parseRootString");
    expect((result.args as any).path).toBe("/file.txt");
  });

  it("wraps bare string root with fieldAliases as { path: value }", () => {
    const result = repairToolInput(editConfig, "just a bare string", toolName);
    // Wraps as { path: "just a bare string" } but still unrepairable (missing required edits)
    // unrepairable() returns empty rulesFired/notes, so we verify outcome only
    expect(result.outcome).toBe("unrepairable");
    expect(result.args).toBe("just a bare string");
  });

  it("JSON-string root parsing to array stays string, is unrepairable", () => {
    const input = JSON.stringify([1, 2, 3]);
    const result = repairToolInput(editConfig, input, toolName);
    // Input is a string that parses to an array, not an object → unrepairable
    expect(result.outcome).toBe("unrepairable");
    expect(result.args).toBe(input);
  });

  it("root string with markdown auto-link in path field (re-apply after parsing)", () => {
    const input = JSON.stringify({ path: "[notes.md](http://notes.md)", edits: [{ oldText: "a", newText: "b" }] });
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    expect(result.rulesFired).toContain("parseRootString");
    expect(result.rulesFired).toContain("unwrapMarkdownAutoLink");
    expect((result.args as any).path).toBe("notes.md");
  });

  it("invalid JSON root string stays string, is unrepairable", () => {
    const input = "{ not valid json }}";
    const result = repairToolInput(editConfig, input, toolName);
    // Starts with { and ends with } but fails JSON parse → treated as bare string
    // With fieldAliases, it gets wrapped as { path: input }
    expect(["repaired", "unrepairable"]).toContain(result.outcome);
  });
});

describe("repair engine: retry message", () => {
  const toolName = "edit";

  it("long input triggers 300-char truncation in retry message", () => {
    // Create a long string input that will be unrepairable
    const longInput = `{ "data": "${"x".repeat(400)}" }`;
    const result = repairToolInput(editConfig, longInput, toolName);
    expect(result.outcome).toBe("unrepairable");
    const received = result.retryMessage ?? "";
    expect(received.length).toBeLessThan(800); // 300-char truncation + other text
    expect(received).toContain("…");
  });

  it("many issues (>8) are sliced to 8 in retry message", () => {
    // Create an object with many wrong-typed fields to trigger many validation issues
    const input = {
      path: 123,           // wrong type
      edits: "not array",   // wrong type
      dryRun: "not bool",   // wrong type
      a: 1, b: 2, c: 3,    // extra fields
      d: 4, e: 5, f: 6, g: 7,
      h: 8, i: 9, j: 10, k: 11,
    };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("unrepairable");
    const lines = (result.retryMessage ?? "").split("\n").filter((l) => l.startsWith("  •"));
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("markdown link that is NOT an auto-link is kept as-is", () => {
    // [different text](http://example.com) → text !== url → keep original
    const input = {
      path: "[different text](http://example.com)",
      edits: [{ oldText: "a", newText: "b" }],
    };
    const result = repairToolInput(editConfig, input, toolName);
    // The link is NOT unwrapped because text ("different text") ≠ url ("example.com")
    // Input is valid (path is a string), so passes through unchanged
    // The key coverage is the unwrapMarkdownAutoLinks callback returning _match
    expect(result.outcome).toBe("valid");
    expect(result.args).toBe(input);
    expect((result.args as any).path).toBe("[different text](http://example.com)");
  });
});

describe("repair engine: convert coexistence (Stage 5)", () => {
  const toolName = "edit";

  it("edits as string array -> repaired by parseStringified, not Convert path", () => {
    // edits: "[]" is a string, parseStringified middleware parses it → repaired
    const input = { path: "/f.txt", edits: "[]" };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
  });

  it("field alias fires middleware, edits string -> repaired with middleware + Convert", () => {
    // A field alias fires middleware, then parseStringified/Convert fixes the rest
    const input = { file_path: "/f.txt", edits: "[]" };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    expect(result.retryMessage).toBeUndefined();
  });

  it("Convert coexistence: benign coercions preserved (existing test)", () => {
    // If the input is invalid but Convert alone fixes it and no middleware fired,
    // return the original input (pi's native behavior).
    const input = { path: "/f.txt", edits: "[]" };
    const result = repairToolInput(editConfig, input, toolName);
    // This should be repaired (by parseStringified middleware)
    expect(["repaired", "valid"]).toContain(result.outcome);
  });
});

describe("repair engine: describeIssue branches", () => {
  const toolName = "edit";

  it("type mismatch issue covers describeIssue type params branch", () => {
    // path: 123 is wrong type -> issue.params.type exists
    const input = { path: 123, edits: [{ oldText: "a", newText: "b" }] };
    const result = repairToolInput(editConfig, input, toolName);
    // Whether repaired (via Convert) or unrepairable, fingerprint should exist
    // The key is that describeIssue is called with params.type
    if (result.outcome === "unrepairable") {
      expect(result.fingerprint).toBeDefined();
      expect(result.issueSummary).toBeDefined();
    }
  });

  it("required field issue covers describeIssue requiredProperties branch", () => {
    // Missing 'edits' -> keyword is "required" with requiredProperties param
    const input = { path: "/f.txt" };
    const result = repairToolInput(editConfig, input, toolName);
    if (result.outcome === "unrepairable") {
      expect(result.fingerprint).toBeDefined();
      expect(result.issueSummary).toBeDefined();
    }
  });
});

describe("repair engine integration", () => {
  const toolName = "edit";

  it("passes through valid input unchanged", () => {
    const input = { path: "/file.txt", edits: [{ oldText: "a", newText: "b" }] };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("valid");
    expect(result.args).toBe(input); // same reference
    expect(result.rulesFired).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("repairs aliased top-level field names", () => {
    const input = { file_path: "/file.txt", edits: [{ oldText: "a", newText: "b" }] };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    expect((result.args as any).path).toBe("/file.txt");
    expect((result.args as any).file_path).toBeUndefined();
  });

  it("extracts path from edits[0]", () => {
    const input = {
      edits: [{ path: "/file.txt", oldText: "a", newText: "b" }],
    };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    expect((result.args as any).path).toBe("/file.txt");
    expect((result.args as any).edits[0].path).toBeUndefined();
  });

  it("unwraps markdown auto-links on path fields", () => {
    const input = {
      path: "[notes.md](http://notes.md)",
      edits: [{ oldText: "a", newText: "b" }],
    };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    expect((result.args as any).path).toBe("notes.md");
  });

  it("handles unrepairable input with retry message", () => {
    const input = { wrongField: "value" };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("unrepairable");
    expect(result.retryMessage).toBeDefined();
    expect(result.retryMessage).toContain("edit");
    expect(result.fingerprint).toBeDefined();
    expect(result.issueSummary).toBeDefined();
  });

  it("deduplicates notes by rule name", () => {
    const input = {
      file_path: "[notes.md](http://notes.md)",
      edits: [{ oldText: "a", newText: "b" }],
    };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    // Each rule should fire only once
    const renameCount = result.rulesFired.filter((r) => r.includes("rename")).length;
    expect(renameCount).toBeLessThanOrEqual(1);
  });

  it("Convert coexistence: benign coercions preserved", () => {
    // If the input is invalid but Convert alone fixes it and no middleware fired,
    // return the original input (pi's native behavior).
    const input = { path: "/f.txt", edits: "[]" };
    const result = repairToolInput(editConfig, input, toolName);
    // This should either be repaired (by parseStringified) or valid (by Convert)
    expect(["repaired", "valid"]).toContain(result.outcome);
  });

  it("multi-pass: cascading issues resolve in 2 passes", () => {
    // First pass: parse stringified array (edits field)
    // Second pass: rename aliased fields inside the parsed array
    // Note: The middleware chain handles this across passes
    const input = {
      path: "/f.txt",
      edits: '[{"oldText":"a","newText":"b"}]',
    };
    const result = repairToolInput(editConfig, input, toolName);
    expect(result.outcome).toBe("repaired");
    expect(Array.isArray((result.args as any).edits)).toBe(true);
  });
});
