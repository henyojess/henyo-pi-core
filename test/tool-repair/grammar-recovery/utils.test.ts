import { describe, it, expect } from "vitest";
import {
  selectCandidates,
  rangesOverlap,
  isAllowedTool,
  removeRanges,
  getPartText,
  setPartText,
  unwrapMarkdownFence,
  isObject,
  findPattern,
  extractFirstBalancedJson,
  findMatching,
  splitTopLevel,
  findTopLevelChar,
  parseJsonValue,
  parseJsonArrayObjects,
  parseJsonValueOrString,
  maybeParseJsonValue,
  parsePythonicCalls,
  parseKeywordArguments,
  parsePythonishValue,
} from "../../../src/tool-repair/grammar-recovery/utils.js";

describe("selectCandidates", () => {
  it("returns all candidates when ranges do not overlap", () => {
    const candidates = [
      { name: "a", range: { start: 0, end: 5 } },
      { name: "b", range: { start: 10, end: 15 } },
      { name: "c", range: { start: 20, end: 25 } },
    ];
    const result = selectCandidates(candidates);
    expect(result).toHaveLength(3);
  });

  it("removes overlapping candidates", () => {
    const candidates = [
      { name: "a", range: { start: 0, end: 10 } },
      { name: "b", range: { start: 5, end: 15 } },
      { name: "c", range: { start: 20, end: 25 } },
    ];
    const result = selectCandidates(candidates);
    // a and b overlap, so one is removed; c is kept
    expect(result).toHaveLength(2);
  });

  it("keeps the longer candidate when ranges are identical at start", () => {
    const candidates = [
      { name: "short", range: { start: 0, end: 5 } },
      { name: "long", range: { start: 0, end: 10 } },
    ];
    const result = selectCandidates(candidates);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("long");
  });

  it("returns empty array for empty input", () => {
    expect(selectCandidates([])).toHaveLength(0);
  });
});

describe("rangesOverlap", () => {
  it("returns true for overlapping ranges", () => {
    expect(rangesOverlap({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true);
  });

  it("returns false for non-overlapping ranges", () => {
    expect(rangesOverlap({ start: 0, end: 5 }, { start: 10, end: 15 })).toBe(false);
  });

  it("returns false for touching ranges (a.end === b.start)", () => {
    expect(rangesOverlap({ start: 0, end: 5 }, { start: 5, end: 10 })).toBe(false);
  });

  it("returns false for identical ranges", () => {
    expect(rangesOverlap({ start: 0, end: 5 }, { start: 0, end: 5 })).toBe(true);
  });

  it("returns true when one range fully contains the other", () => {
    expect(rangesOverlap({ start: 0, end: 20 }, { start: 5, end: 10 })).toBe(true);
  });
});

describe("isAllowedTool", () => {
  it("returns true when requireKnownTool is false", () => {
    expect(isAllowedTool("anyTool", false, new Set())).toBe(true);
  });

  it("returns true when tool is in knownTools set", () => {
    expect(isAllowedTool("read", true, new Set(["read", "write"]))).toBe(true);
  });

  it("returns false when tool is not in knownTools set", () => {
    expect(isAllowedTool("unknown", true, new Set(["read", "write"]))).toBe(false);
  });

  it("returns false when knownTools is empty and requireKnownTool is true", () => {
    expect(isAllowedTool("read", true, new Set())).toBe(false);
  });

  it("returns true when knownTools is empty and requireKnownTool is false", () => {
    expect(isAllowedTool("anything", false, new Set())).toBe(true);
  });
});

describe("removeRanges", () => {
  it("removes a single range from the middle of text", () => {
    const result = removeRanges("Hello WORLD!", [{ start: 6, end: 12 }]);
    expect(result).toBe("Hello");
  });

  it("removes multiple non-overlapping ranges", () => {
    const result = removeRanges("abcDEFghiJKLmno", [
      { start: 3, end: 6 },
      { start: 9, end: 12 },
    ]);
    expect(result).toBe("abcghimno");
  });

  it("handles ranges at the start", () => {
    const result = removeRanges("Hello World", [{ start: 0, end: 5 }]);
    expect(result).toBe("World");
  });

  it("handles ranges at the end", () => {
    const result = removeRanges("Hello World", [{ start: 6, end: 11 }]);
    expect(result).toBe("Hello");
  });

  it("trims excess whitespace (blank lines, trailing spaces)", () => {
    const result = removeRanges("Hello\n\n\n  \n  World", [
      { start: 5, end: 10 },
    ]);
    expect(result).toBe("Hello\n  World");
  });

  it("returns original text when no ranges provided", () => {
    expect(removeRanges("hello", [])).toBe("hello");
  });
});

describe("getPartText", () => {
  it("returns text for text type content", () => {
    expect(getPartText({ type: "text", text: "hello" })).toBe("hello");
  });

  it("returns thinking for thinking type content", () => {
    expect(getPartText({ type: "thinking", thinking: "thinking content" })).toBe(
      "thinking content",
    );
  });

  it("returns undefined for non-text content", () => {
    expect(getPartText({ type: "toolCall", name: "read" })).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(getPartText("not an object" as any)).toBeUndefined();
  });
});

describe("setPartText", () => {
  it("sets text for text type", () => {
    const result = setPartText({ type: "text", text: "old" }, "new");
    expect(result).toEqual({ type: "text", text: "new" });
  });

  it("sets thinking for thinking type", () => {
    const result = setPartText({ type: "thinking", thinking: "old" }, "new");
    expect(result).toEqual({ type: "thinking", thinking: "new" });
  });

  it("returns part unchanged for non-text type", () => {
    const part = { type: "toolCall", name: "read" };
    const result = setPartText(part, "text");
    expect(result).toBe(part);
  });
});

describe("unwrapMarkdownFence", () => {
  it("strips code fence wrapper", () => {
    expect(unwrapMarkdownFence("```javascript\nhello\n```")).toBe("hello");
  });

  it("strips code fence without language", () => {
    expect(unwrapMarkdownFence("```\nhello\n```")).toBe("hello");
  });

  it("returns text as-is when no fence", () => {
    expect(unwrapMarkdownFence("hello world")).toBe("hello world");
  });

  it("handles fence with trailing content", () => {
    expect(unwrapMarkdownFence("```\ncode\n```\nmore")).toBe("```\ncode\n```\nmore");
  });
});

describe("isObject", () => {
  it("returns true for plain objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isObject(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isObject([1, 2, 3])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isObject("string")).toBe(false);
    expect(isObject(123)).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

describe("findPattern", () => {
  it("finds a regex pattern at a given position", () => {
    const result = findPattern("Hello world", /world/, 0);
    expect(result).toEqual({ start: 6, end: 11 });
  });

  it("finds a pattern after the from position", () => {
    const result = findPattern("Hello world", /world/, 5);
    expect(result).toEqual({ start: 6, end: 11 });
  });

  it("returns undefined when pattern not found", () => {
    const result = findPattern("Hello world", /xyz/, 0);
    expect(result).toBeUndefined();
  });

  it("respects the from offset", () => {
    const result = findPattern("Hello world hello", /hello/, 6);
    expect(result).toEqual({ start: 12, end: 17 });
  });
});

describe("extractFirstBalancedJson", () => {
  it("extracts a JSON object", () => {
    const result = extractFirstBalancedJson('{"key": "value"}');
    expect(result).toEqual({
      json: '{"key": "value"}',
      start: 0,
      end: 16,
    });
  });

  it("extracts a JSON array", () => {
    const result = extractFirstBalancedJson('[1, 2, 3]');
    expect(result).toEqual({
      json: '[1, 2, 3]',
      start: 0,
      end: 9,
    });
  });

  it("handles nested braces", () => {
    const result = extractFirstBalancedJson('{"outer": {"inner": 1}}');
    expect(result).toEqual({
      json: '{"outer": {"inner": 1}}',
      start: 0,
      end: 23,
    });
  });

  it("returns undefined for non-JSON text", () => {
    expect(extractFirstBalancedJson("hello world")).toBeUndefined();
  });

  it("returns undefined when no opening bracket found", () => {
    expect(extractFirstBalancedJson("no brackets here")).toBeUndefined();
  });

  it("finds JSON after some prefix text", () => {
    const result = extractFirstBalancedJson("prefix {\"key\": 1}");
    expect(result).toEqual({
      json: '{"key": 1}',
      start: 7,
      end: 17,
    });
  });
});

describe("findMatching", () => {
  it("finds matching brace for balanced input", () => {
    expect(findMatching("{hello}", 0, "{", "}")).toBe(6);
  });

  it("finds matching parenthesis", () => {
    expect(findMatching("(hello)", 0, "(", ")")).toBe(6);
  });

  it("finds matching bracket", () => {
    expect(findMatching("[hello]", 0, "[", "]")).toBe(6);
  });

  it("returns undefined for unbalanced input", () => {
    expect(findMatching("{hello", 0, "{", "}")).toBeUndefined();
  });

  it("handles nested structures", () => {
    expect(findMatching("{[()]}]", 0, "{", "}")).toBe(5);
  });

  it("handles quoted strings with braces inside", () => {
    expect(findMatching('{"key": "value}"}', 0, "{", "}")).toBe(16);
  });

  it("handles escaped quotes", () => {
    expect(findMatching('{\"escaped\": \"value\"}', 0, "{", "}")).toBe(19);
  });

  it("handles single quotes", () => {
    expect(findMatching("{'key': 'value'}", 0, "{", "}")).toBe(15);
  });
});

describe("splitTopLevel", () => {
  it("splits by comma at top level only", () => {
    const result = splitTopLevel("a,b,c", ",");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("ignores commas inside braces", () => {
    const result = splitTopLevel('{"a": 1, "b": 2}', ",");
    expect(result).toEqual(['{"a": 1, "b": 2}']);
  });

  it("ignores commas inside brackets", () => {
    const result = splitTopLevel("[1, 2, 3]", ",");
    expect(result).toEqual(["[1, 2, 3]"]);
  });

  it("ignores commas inside parentheses", () => {
    const result = splitTopLevel("func(a, b, c)", ",");
    expect(result).toEqual(["func(a, b, c)"]);
  });

  it("ignores commas inside quoted strings", () => {
    const result = splitTopLevel('"a,b", c', ",");
    expect(result).toEqual(['"a,b"', "c"]);
  });

  it("handles nested structures", () => {
    const result = splitTopLevel('{"a": [1, 2]}, {"b": 3}', ",");
    expect(result).toEqual(['{"a": [1, 2]}', '{"b": 3}']);
  });

  it("returns single element when no delimiter found", () => {
    const result = splitTopLevel("hello", ",");
    expect(result).toEqual(["hello"]);
  });

  it("trims and filters empty parts", () => {
    const result = splitTopLevel("a,,b", ",");
    expect(result).toEqual(["a", "b"]);
  });
});

describe("findTopLevelChar", () => {
  it("finds target at top level", () => {
    expect(findTopLevelChar("a,b,c", ",")).toBe(1);
  });

  it("skips target inside nested structures", () => {
    expect(findTopLevelChar("func(a,b),c", ",")).toBe(9);
  });

  it("returns -1 when not found", () => {
    expect(findTopLevelChar("hello world", ",")).toBe(-1);
  });

  it("skips target inside quoted strings", () => {
    expect(findTopLevelChar('"a,b", c', ",")).toBe(5);
  });

  it("finds first occurrence at top level", () => {
    expect(findTopLevelChar("x,y,z", ",")).toBe(1);
  });
});

describe("parseJsonValue", () => {
  it("parses valid JSON string", () => {
    expect(parseJsonValue('"hello"')).toBe("hello");
  });

  it("parses valid JSON number", () => {
    expect(parseJsonValue("42")).toBe(42);
  });

  it("parses valid JSON boolean", () => {
    expect(parseJsonValue("true")).toBe(true);
    expect(parseJsonValue("false")).toBe(false);
  });

  it("parses valid JSON null", () => {
    expect(parseJsonValue("null")).toBeNull();
  });

  it("parses valid JSON object", () => {
    expect(parseJsonValue('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("parses valid JSON array", () => {
    expect(parseJsonValue("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseJsonValue("{invalid}")).toBeUndefined();
  });

  it("returns undefined for plain text", () => {
    expect(parseJsonValue("hello world")).toBeUndefined();
  });
});

describe("parseJsonArrayObjects", () => {
  it("filters objects from array", () => {
    const result = parseJsonArrayObjects('[{"a": 1}, "string", {"b": 2}]');
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns empty array for non-array input", () => {
    expect(parseJsonArrayObjects('{"key": "value"}')).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseJsonArrayObjects("not json")).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(parseJsonArrayObjects("[]")).toEqual([]);
  });
});

describe("parseJsonValueOrString", () => {
  it("returns parsed JSON for valid JSON", () => {
    expect(parseJsonValueOrString('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns raw string for invalid JSON", () => {
    expect(parseJsonValueOrString("hello world")).toBe("hello world");
  });

  it("returns parsed number", () => {
    expect(parseJsonValueOrString("42")).toBe(42);
  });

  it("returns parsed string", () => {
    expect(parseJsonValueOrString('"hello"')).toBe("hello");
  });
});

describe("maybeParseJsonValue", () => {
  it("returns empty string for empty input", () => {
    expect(maybeParseJsonValue("")).toBe("");
  });

  it("parses JSON-like string starting with {", () => {
    expect(maybeParseJsonValue('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("parses JSON-like string starting with [", () => {
    expect(maybeParseJsonValue("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("parses JSON-like string starting with true", () => {
    expect(maybeParseJsonValue("true")).toBe(true);
  });

  it("parses JSON-like string starting with false", () => {
    expect(maybeParseJsonValue("false")).toBe(false);
  });

  it("parses JSON-like string starting with null", () => {
    expect(maybeParseJsonValue("null")).toBeNull();
  });

  it("parses JSON-like string starting with number", () => {
    expect(maybeParseJsonValue("42")).toBe(42);
  });

  it("parses JSON-like string starting with quote", () => {
    expect(maybeParseJsonValue('"hello"')).toBe("hello");
  });

  it("returns plain string as-is", () => {
    expect(maybeParseJsonValue("hello world")).toBe("hello world");
  });

  it("returns plain string starting with letter", () => {
    expect(maybeParseJsonValue("functionName")).toBe("functionName");
  });
});

describe("parsePythonicCalls", () => {
  it("parses single function call", () => {
    const result = parsePythonicCalls("read_file(path='test.txt')");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(result[0].arguments).toEqual({ path: "test.txt" });
  });

  it("parses multiple function calls", () => {
    const result = parsePythonicCalls(
      "read_file(path='test.txt')\nwrite_file(path='out.txt')",
    );
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("read_file");
    expect(result[1].name).toBe("write_file");
  });

  it("parses function call with keyword arguments", () => {
    const result = parsePythonicCalls("func(a=1, b=2, c=3)");
    expect(result).toHaveLength(1);
    expect(result[0].arguments).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("parses function call with True, False, None values", () => {
    const result = parsePythonicCalls("func(a=True, b=False, c=None)");
    expect(result).toHaveLength(1);
    expect(result[0].arguments).toEqual({ a: true, b: false, c: null });
  });

  it("parses function call with string arguments", () => {
    const result = parsePythonicCalls("func(a='hello', b=\"world\")");
    expect(result).toHaveLength(1);
    expect(result[0].arguments).toEqual({ a: "hello", b: "world" });
  });

  it("parses function call with numeric arguments", () => {
    const result = parsePythonicCalls("func(x=42, y=3.14)");
    expect(result).toHaveLength(1);
    expect(result[0].arguments).toEqual({ x: 42, y: 3.14 });
  });

  it("returns empty array for no function calls", () => {
    expect(parsePythonicCalls("just plain text")).toEqual([]);
  });
});

describe("parseKeywordArguments", () => {
  it("parses simple key=value pairs", () => {
    const result = parseKeywordArguments("a=1, b=2, c=3");
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("parses string values", () => {
    const result = parseKeywordArguments("name='hello', path='/test'");
    expect(result).toEqual({ name: "hello", path: "/test" });
  });

  it("ignores invalid key names", () => {
    const result = parseKeywordArguments("123=bad, valid=good");
    expect(result).toEqual({ valid: "good" });
  });

  it("handles empty args", () => {
    expect(parseKeywordArguments("")).toEqual({});
  });

  it("handles args without equals sign", () => {
    const result = parseKeywordArguments("value1, value2");
    expect(result).toEqual({});
  });
});

describe("parsePythonishValue", () => {
  it("parses Python True as boolean true", () => {
    expect(parsePythonishValue("True")).toBe(true);
  });

  it("parses Python False as boolean false", () => {
    expect(parsePythonishValue("False")).toBe(false);
  });

  it("parses Python None as null", () => {
    expect(parsePythonishValue("None")).toBeNull();
  });

  it("parses integer", () => {
    expect(parsePythonishValue("42")).toBe(42);
  });

  it("parses negative integer", () => {
    expect(parsePythonishValue("-5")).toBe(-5);
  });

  it("parses float", () => {
    expect(parsePythonishValue("3.14")).toBe(3.14);
  });

  it("parses quoted string (single quotes)", () => {
    expect(parsePythonishValue("'hello'")).toBe("hello");
  });

  it("parses quoted string (double quotes)", () => {
    expect(parsePythonishValue('"hello"')).toBe("hello");
  });

  it("strips escape sequences in quoted strings", () => {
    expect(parsePythonishValue("'it\\'s'")).toBe("it's");
  });

  it("parses JSON-like value via fallback", () => {
    expect(parsePythonishValue('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns plain string for unparseable value", () => {
    expect(parsePythonishValue("hello world")).toBe("hello world");
  });
});
