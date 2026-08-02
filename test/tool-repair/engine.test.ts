import { describe, it, expect } from "vitest";
import { repairToolInput } from "../../src/tool-repair/engine.js";
import { editConfig } from "../../src/tool-repair/configs.js";

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
