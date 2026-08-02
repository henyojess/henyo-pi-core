import { describe, it, expect } from "vitest";
import {
  modelLeaksGrammar,
  recoverGrammarLeaks,
  GRAMMAR_NAMES,
} from "../../src/tool-repair/grammar-recovery.js";

describe("grammar recovery", () => {
  describe("modelLeaksGrammar", () => {
    it("matches glm models", () => {
      expect(modelLeaksGrammar("glm-4")).toBe(true);
      expect(modelLeaksGrammar("chatglm-6b")).toBe(true);
    });

    it("matches kimi models", () => {
      expect(modelLeaksGrammar("kimi-k2")).toBe(true);
      expect(modelLeaksGrammar("kimi-latest")).toBe(true);
    });

    it("matches minimax models", () => {
      expect(modelLeaksGrammar("minimax-m1")).toBe(true);
    });

    it("matches qwen models", () => {
      expect(modelLeaksGrammar("qwen-2.5")).toBe(true);
    });

    it("does NOT match Claude/GPT", () => {
      expect(modelLeaksGrammar("claude-3-opus")).toBe(false);
      expect(modelLeaksGrammar("gpt-4o")).toBe(false);
      expect(modelLeaksGrammar("gemini-pro")).toBe(false);
    });

    it("returns false for undefined model", () => {
      expect(modelLeaksGrammar(undefined)).toBe(false);
    });
  });

  describe("recoverGrammarLeaks", () => {
    const baseMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "" }],
    };

    it("returns unchanged when mode is off", () => {
      const msg = { ...baseMessage, content: [{ type: "text", text: "hello" }] };
      const result = recoverGrammarLeaks(msg, {
        mode: "off",
        knownTools: new Set(["read", "bash"]),
      });
      expect(result.changed).toBe(false);
    });

    it("strips granite grammar from text in strip mode", () => {
      // Granite uses <tool_call> wrapper with JSON body
      const graniteBlock = `<tool_call>{"name": "read", "arguments": {"path": "file.txt"}}</tool_call>`;
      const msg = {
        ...baseMessage,
        content: [{ type: "text", text: `Some text\n${graniteBlock}\nMore text` }],
      };
      const result = recoverGrammarLeaks(msg, {
        mode: "strip",
        knownTools: new Set(["read", "bash"]),
      });
      expect(result.changed).toBe(true);
      expect(result.strippedGrammars).toContain("granite");
    });

    it("recovers calls in recover mode on stopReason stop", () => {
      const graniteBlock = `<tool_call>{"name": "read", "arguments": {"path": "file.txt"}}</tool_call>`;
      const msg = {
        ...baseMessage,
        content: [{ type: "text", text: graniteBlock }],
        stopReason: "stop",
      };
      const result = recoverGrammarLeaks(msg, {
        mode: "recover",
        knownTools: new Set(["read", "bash"]),
      });
      expect(result.changed).toBe(true);
      expect(result.promoted).toBe(true);
      expect(result.recoveredCalls.length).toBeGreaterThan(0);
    });

    it("does NOT recover on stopReason length", () => {
      const graniteBlock = `<tool_call>{"name": "read", "arguments": {"path": "file.txt"}}</tool_call>`;
      const msg = {
        ...baseMessage,
        content: [{ type: "text", text: graniteBlock }],
        stopReason: "length",
      };
      const result = recoverGrammarLeaks(msg, {
        mode: "recover",
        knownTools: new Set(["read", "bash"]),
      });
      // Stripping should still happen, but not promotion
      expect(result.changed).toBe(true);
      expect(result.promoted).toBe(false);
    });

    it("does NOT promote unknown tools (and does NOT strip when requireKnownTool=true)", () => {
      const glmBlock = `<tool_call>{"name": "read", "arguments": {"path": "file.txt"}}</tool_call>`;
      const msg = {
        ...baseMessage,
        content: [{ type: "text", text: glmBlock }],
        stopReason: "stop",
      };
      const result = recoverGrammarLeaks(msg, {
        mode: "recover",
        knownTools: new Set(["bash", "grep"]), // read not in list
        requireKnownTool: true,
      });
      // Unknown tools are filtered out entirely when requireKnownTool=true
      expect(result.changed).toBe(false);
      expect(result.promoted).toBe(false);
    });

    it("does NOT promote empty args", () => {
      const glmBlock = `<tool_call>{"name": "read", "arguments": {}}</tool_call>`;
      const msg = {
        ...baseMessage,
        content: [{ type: "text", text: glmBlock }],
        stopReason: "stop",
      };
      const result = recoverGrammarLeaks(msg, {
        mode: "recover",
        knownTools: new Set(["read", "bash"]),
      });
      expect(result.changed).toBe(true);
      expect(result.promoted).toBe(false);
    });
  });

  describe("GRAMMAR_NAMES", () => {
    it("includes all known grammar families", () => {
      expect(GRAMMAR_NAMES).toContain("dsml");
      expect(GRAMMAR_NAMES).toContain("glm");
      expect(GRAMMAR_NAMES).toContain("kimi");
      expect(GRAMMAR_NAMES).toContain("granite");
      expect(GRAMMAR_NAMES.length).toBeGreaterThan(5);
    });
  });
});
