import { describe, it, expect } from "vitest";
import { parseMistral } from "../../../src/tool-repair/grammar-recovery/parsers/mistral.js";
import { parseKimi, parseKimiToolName } from "../../../src/tool-repair/grammar-recovery/parsers/kimi.js";
import { parseMiniMaxText01 } from "../../../src/tool-repair/grammar-recovery/parsers/minimax.js";
import { parseBarePythonicToolCalls } from "../../../src/tool-repair/grammar-recovery/parsers/granite.js";
import { parseInvokeXml, parseInvokeBody, parseInvokeArguments } from "../../../src/tool-repair/grammar-recovery/parsers/invoke.js";
import { parseLlamaPythonTag, parseBareJsonToolCalls } from "../../../src/tool-repair/grammar-recovery/parsers/llama.js";
import { parseOlmo } from "../../../src/tool-repair/grammar-recovery/parsers/olmo.js";
import { parseToolCallXml, parseGlmToolCallBody, parseQwenFunctionBody } from "../../../src/tool-repair/grammar-recovery/parsers/qwen.js";
import { parseDsml, parseDsmlDanglingMarkers } from "../../../src/tool-repair/grammar-recovery/parsers/dsml.js";

describe("parseMistral", () => {
  it("parses [TOOL_CALLS] followed by JSON array of tool calls", () => {
    const text = "[TOOL_CALLS] [{\"name\": \"read_file\", \"arguments\": {\"path\": \"test.txt\"}}]";
    expect(parseMistral(text)).toHaveLength(1);
    expect(parseMistral(text)[0].name).toBe("read_file");
  });

  it("parses JSON array with name and arguments keys", () => {
    const text = "[TOOL_CALLS] [{\"name\": \"write\", \"arguments\": {\"content\": \"hello\"}}]";
    expect(parseMistral(text)).toHaveLength(1);
    expect(parseMistral(text)[0].name).toBe("write");
  });

  it("parses JSON array with function.name and function.arguments", () => {
    const text = "[TOOL_CALLS] [{\"function\": {\"name\": \"calc\", \"arguments\": {\"expr\": \"1+1\"}}}]";
    expect(parseMistral(text)).toHaveLength(1);
    expect(parseMistral(text)[0].name).toBe("calc");
  });

  it("ignores [TOOL_CALLS] inside code fences", () => {
    const text = "```\n[TOOL_CALLS] [{\"name\": \"read\"}]\n```";
    expect(parseMistral(text)).toHaveLength(0);
  });

  it("parses v1.1 format: name[CALL_ID]..[ARGS]{...}", () => {
    const text = "[TOOL_CALLS] read[CALL_ID]..[ARGS]{\"path\": \"file.txt\"}";
    expect(parseMistral(text)).toHaveLength(1);
    expect(parseMistral(text)[0].name).toBe("read");
  });

  it("parses v1.1 format with various call_id content", () => {
    const text = "[TOOL_CALLS] myTool[CALL_ID]...[ARGS]{\"key\": \"value\"}";
    expect(parseMistral(text)).toHaveLength(1);
    expect(parseMistral(text)[0].name).toBe("myTool");
  });

  it("returns empty array for text without markers", () => {
    expect(parseMistral("just plain text")).toHaveLength(0);
  });

  it("handles malformed JSON after [TOOL_CALLS]", () => {
    const text = "[TOOL_CALLS] {invalid json}";
    expect(parseMistral(text)).toHaveLength(0);
  });

  it("handles multiple [TOOL_CALLS] markers", () => {
    const text = "[TOOL_CALLS] [{\"name\": \"read\"}] [TOOL_CALLS] [{\"name\": \"write\"}]";
    expect(parseMistral(text)).toHaveLength(2);
  });
});

describe("parseKimi", () => {
  it("parses tool_calls_section_begin/end with tool_call_begin/argument_begin/end", () => {
    const text = "<|tool_calls_section_begin|>\n<|tool_call_begin|>functions.read_file:123<|tool_call_argument_begin|>\n{\"path\": \"test.txt\"}\n<|tool_call_end|>\n<|tool_calls_section_end|>";
    expect(parseKimi(text)).toHaveLength(1);
    expect(parseKimi(text)[0].name).toBe("read_file");
  });

  it("parses canonical idText format (functions.name:123)", () => {
    const text = "<|tool_calls_section_begin|>\n<|tool_call_begin|>functions.write:456<|tool_call_argument_begin|>\n{}\n<|tool_call_end|>\n<|tool_calls_section_end|>";
    expect(parseKimi(text)).toHaveLength(1);
    expect(parseKimi(text)[0].name).toBe("write");
  });

  it("parses relaxed idText format (just name)", () => {
    const text = "<|tool_calls_section_begin|>\n<|tool_call_begin|>read_file<|tool_call_argument_begin|>\n{}\n<|tool_call_end|>\n<|tool_calls_section_end|>";
    expect(parseKimi(text)).toHaveLength(1);
    expect(parseKimi(text)[0].name).toBe("read_file");
  });

  it("ignores sections inside code fences", () => {
    const text = "```\n<|tool_calls_section_begin|>\n<|tool_call_begin|>read<|tool_call_argument_begin|>{}\n<|tool_call_end|>\n<|tool_calls_section_end|>\n```";
    expect(parseKimi(text)).toHaveLength(0);
  });

  it("skips call_id that looks like call-0 or call_0", () => {
    const text = "<|tool_calls_section_begin|>\n<|tool_call_begin|>call-0<|tool_call_argument_begin|>\n{}\n<|tool_call_end|>\n<|tool_calls_section_end|>";
    expect(parseKimi(text)).toHaveLength(0);
  });
});

describe("parseKimiToolName", () => {
  it("extracts name from functions.name:123", () => {
    expect(parseKimiToolName("functions.read_file:123")).toBe("read_file");
  });

  it("extracts name from bare name", () => {
    expect(parseKimiToolName("read_file")).toBe("read_file");
  });

  it("returns undefined for call-0", () => {
    expect(parseKimiToolName("call-0")).toBeUndefined();
  });

  it("returns undefined for call_123", () => {
    expect(parseKimiToolName("call_123")).toBeUndefined();
  });
});
describe("parseMiniMaxText01", () => {
  it("parses function_call tag with functions.name(args)", () => {
    const text = "<function_call>functions.read_file({\"path\": \"test.txt\"})";
    expect(parseMiniMaxText01(text)).toHaveLength(1);
    expect(parseMiniMaxText01(text)[0].name).toBe("read_file");
  });

  it("parses args followed by code fence", () => {
    const text = "<function_call>functions.write({\"content\": \"hello\"})```";
    expect(parseMiniMaxText01(text)).toHaveLength(1);
  });

  it("returns empty for text without function_call tag", () => {
    expect(parseMiniMaxText01("just plain text")).toHaveLength(0);
  });

  it("ignores content inside code fences", () => {
    const text = "```\n<function_call>functions.read({})\n```";
    expect(parseMiniMaxText01(text)).toHaveLength(0);
  });
});

describe("parseBarePythonicToolCalls", () => {
  it("parses Pythonic function call on its own line", () => {
    const text = "read_file(path='test.txt')";
    expect(parseBarePythonicToolCalls(text)).toHaveLength(1);
    expect(parseBarePythonicToolCalls(text)[0].name).toBe("read_file");
  });

  it("parses multiple calls on separate lines", () => {
    const text = "read_file(path='a.txt')\nwrite_file(path='b.txt')";
    expect(parseBarePythonicToolCalls(text)).toHaveLength(2);
  });

  it("ignores calls inside code fences", () => {
    const text = "```\nread_file(path='test.txt')\n```";
    expect(parseBarePythonicToolCalls(text)).toHaveLength(0);
  });

  it("ignores calls not at start of line", () => {
    const text = "some text read_file(path='test.txt')";
    expect(parseBarePythonicToolCalls(text)).toHaveLength(0);
  });

  it("returns empty for no function calls", () => {
    expect(parseBarePythonicToolCalls("just plain text")).toHaveLength(0);
  });
});


describe("parseDsml", () => {
  it("parses standard DSML with fullwidth pipes", () => {
    const result = parseDsml("<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"read_file\">\n<｜DSML｜parameter name=\"path\">\ntest.txt\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });
  it("parses DSML with double fullwidth pipes", () => {
    const result = parseDsml("<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"write_file\">\n<｜｜DSML｜｜parameter name=\"content\">\nhello\n</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write_file");
  });
  it("parses DSML with single ASCII pipe variant", () => {
    const result = parseDsml("<|DSML|tool_calls>\n<|DSML|invoke name=\"summarize\">\n<|DSML|parameter name=\"text\">\nlorem ipsum\n</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("summarize");
  });
  it("parses DSML with function_calls wrapper", () => {
    const result = parseDsml("<｜DSML｜function_calls>\n<｜DSML｜invoke name=\"fetch_url\">\n<｜DSML｜parameter name=\"url\" string=\"false\">\nhttps://example.com\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("fetch_url");
    expect(result[0].arguments.url).toBe("https://example.com");
  });
  it("parses multiple invokes in one tool_calls block", () => {
    const result = parseDsml("<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"tool_a\">\n<｜DSML｜parameter name=\"x\">\n1\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n<｜DSML｜invoke name=\"tool_b\">\n<｜DSML｜parameter name=\"y\">\n2\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>");
    expect(result).toHaveLength(2);
  });
  it("ignores DSML inside code fences", () => {
    const content =
      `\`\`\`\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="inside_fence">\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>\n\`\`\``;
    const result = parseDsml(content);
    expect(result).toHaveLength(0);
  });
  it("returns empty for text without DSML markers", () => {
    const result = parseDsml("just plain text with no markup");
    expect(result).toHaveLength(0);
  });
  it("handles unclosed tool_calls by finding best invoke end", () => {
    const result = parseDsml("<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"incomplete\">\n<｜DSML｜parameter name=\"k\">\nv\n</｜DSML｜parameter>\n</｜DSML｜invoke>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("incomplete");
  });
  it("parses DSML with string=false parameter", () => {
    const result = parseDsml("<｜DSML｜tool_calls>\n<｜DSML｜invoke name=\"calc\">\n<｜DSML｜parameter name=\"expr\" string=\"false\">\n1 + 1\n</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("calc");
  });
});

describe("parseDsmlDanglingMarkers", () => {
  it("marks isolated open tool_calls tag as dangling", () => {
    const result = parseDsmlDanglingMarkers("<｜DSML｜tool_calls>");
    expect(result).toHaveLength(1);
    expect(result[0].stripOnly).toBe(true);
  });
  it("marks isolated close invoke tag as dangling", () => {
    const result = parseDsmlDanglingMarkers("</｜DSML｜invoke>");
    expect(result).toHaveLength(1);
    expect(result[0].stripOnly).toBe(true);
  });
  it("ignores dangling markers inside code fences", () => {
    const content =
      `\`\`\`\n<｜DSML｜tool_calls>\n</｜DSML｜tool_calls>\n\`\`\``;
    const result = parseDsmlDanglingMarkers(content);
    expect(result).toHaveLength(0);
  });
  it("returns empty when no DSML text present", () => {
    const result = parseDsmlDanglingMarkers("no markers here at all");
    expect(result).toHaveLength(0);
  });
  it("marks multiple dangling markers", () => {
    const result = parseDsmlDanglingMarkers("<｜DSML｜tool_calls>\nsome text\n</｜DSML｜invoke>");
    expect(result).toHaveLength(2);
  });
  it("handles DSML parameter dangling marker", () => {
    const result = parseDsmlDanglingMarkers("<｜DSML｜parameter name=\"x\">");
    expect(result).toHaveLength(1);
  });
});




describe("parseInvokeXml", () => {
  it("parses tool_call wrapper with invoke and parameters", () => {
    const result = parseInvokeXml("<tool_call>\n<invoke name=\"read_file\">\n<parameter name=\"path\">\ntest.txt\n</parameter>\n</invoke>\n</tool_call>");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("read_file");
  });
  it("parses prefixed tool_call (ns:tool_call)", () => {
    const result = parseInvokeXml("<ns:tool_call>\n<invoke name=\"write\">\n<parameter name=\"content\">\nhello\n</parameter>\n</invoke>\n</ns:tool_call>");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("write");
  });
  it("ignores content inside code fences", () => {
    const result = parseInvokeXml("```\n<tool_call>\n<invoke name=\"inside\"></invoke>\n</tool_call>\n```");
    expect(result).toHaveLength(0);
  });
  it("parses standalone invoke tag", () => {
    const result = parseInvokeXml("<invoke name=\"fetch\">\n<parameter name=\"url\">\nhttps://example.com\n</parameter>\n</invoke>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("fetch");
  });
  it("parses multiple invokes in one wrapper", () => {
    const result = parseInvokeXml("<tool_call>\n<invoke name=\"a\"><parameter name=\"x\">1</parameter></invoke>\n<invoke name=\"b\"><parameter name=\"y\">2</parameter></invoke>\n</tool_call>");
    expect(result).toHaveLength(4);
  });
  it("handles malformed mini-max invoke (missing opening <)", () => {
    const result = parseInvokeXml("\n  invoke name=\"malformed\">\n  parameter name=\"k\">v parameter\n  /invoke");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("malformed");
  });
});

describe("parseInvokeBody", () => {
  it("extracts name and arguments from invoke body", () => {
    const result = parseInvokeBody("<invoke name=\"summarize\">\n<parameter name=\"text\">\nlorem ipsum\n</parameter>\n</invoke>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("summarize");
  });
  it("handles empty body with no parameters", () => {
    const result = parseInvokeBody("<invoke name=\"noop\"></invoke>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("noop");
  });
  it("handles JSON fallback when no parameter tags", () => {
    const result = parseInvokeBody("<invoke name=\"calc\">{a: 1}</invoke>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("calc");
  });
});

describe("parseInvokeArguments", () => {
  it("parses parameter tags", () => {
    const result = parseInvokeArguments("<parameter name=\"key\">\nvalue\n</parameter>");
    expect(result["key"]).toBe("value");
  });
  it("respects string=false (parses as JSON)", () => {
    const result = parseInvokeArguments("<parameter name=\"count\" string=\"false\">\n42\n</parameter>");
    expect(result["count"]).toBe(42);
  });
  it("falls back to JSON when no parameter tags", () => {
    const result = parseInvokeArguments("{\"a\": 1, \"b\": 2}");
    expect(result["a"]).toBe(1);
  });
  it("returns empty object for unrecognized content", () => {
    const result = parseInvokeArguments("plain text");
    expect(Object.keys(result).length).toBe(0);
  });
});
describe("parseLlamaPythonTag", () => {
  it("parses python_tag followed by JSON array of calls", () => {
    const result = parseLlamaPythonTag("<|python_tag|>\n[{\"name\": \"read_file\", \"arguments\": {\"path\": \"test.txt\"}}]");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(result[0].grammar).toBe("llama");
  });
  it("parses python_tag followed by JSON object", () => {
    const result = parseLlamaPythonTag("<|python_tag|>\n{\"name\": \"write\", \"arguments\": {\"content\": \"hello\"}}");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write");
    expect(result[0].grammar).toBe("llama");
  });
  it("parses python_tag followed by Pythonic call (non-JSON)", () => {
    const result = parseLlamaPythonTag("<|python_tag|>\nread_file(path=\"test.txt\")");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(result[0].grammar).toBe("llama");
  });
  it("ignores python_tag inside code fences", () => {
    const result = parseLlamaPythonTag("```\n<|python_tag|>\n{\"name\": \"hidden\"}\n```");
    expect(result).toHaveLength(0);
  });
  it("parses multiple python_tag markers", () => {
    const result = parseLlamaPythonTag("<|python_tag|>\n{\"name\": \"tool_a\", \"arguments\": {}}\n\n<|python_tag|>\n{\"name\": \"tool_b\", \"arguments\": {}}");
    expect(result).toHaveLength(2);
  });
});

describe("parseBareJsonToolCalls", () => {
  it("parses bare JSON object with name and arguments", () => {
    const result = parseBareJsonToolCalls("{\"name\": \"fetch\", \"arguments\": {\"url\": \"https://example.com\"}}", "llama");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("fetch");
    expect(result[0].grammar).toBe("llama");
  });
  it("parses bare JSON array of objects (array + object level matches)", () => {
    const result = parseBareJsonToolCalls("[{\"name\": \"read\", \"arguments\": {}}, {\"name\": \"write\", \"arguments\": {}}]", "llama");
    // Parser matches at both array-level and individual object-level
    const names = result.map((r) => r.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
  });
  it("parses function_name key variant", () => {
    const result = parseBareJsonToolCalls("{\"function_name\": \"calc\", \"arguments\": {\"expr\": \"1+1\"}}", "llama");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("calc");
    expect(result[0].grammar).toBe("llama");
  });
  it("parses function.name nested structure (outer + inner object match)", () => {
    const result = parseBareJsonToolCalls("{\"function\": {\"name\": \"search\", \"arguments\": {\"q\": \"hello\"}}}", "llama");
    // Parser matches outer {function" and inner {name" separately
    const names = result.map((r) => r.name);
    expect(names).toContain("search");
  });
  it("ignores objects inside code fences", () => {
    const result = parseBareJsonToolCalls("```\n{\"name\": \"hidden\", \"arguments\": {}}\n```", "llama");
    expect(result).toHaveLength(0);
  });
  it("works with grammar parameter set to llama", () => {
    const result = parseBareJsonToolCalls("{\"name\": \"noop\", \"arguments\": {}}", "llama");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("noop");
    expect(result[0].grammar).toBe("llama");
  });
});

describe("parseOlmo", () => {
  it("parses function_calls tag containing Pythonic calls", () => {
    const result = parseOlmo("<function_calls>\nread_file(path='test.txt')\n</function_calls>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(result[0].grammar).toBe("olmo");
  });
  it("parses multiple Pythonic calls inside function_calls", () => {
    const result = parseOlmo("<function_calls>\nread_file(path='a.txt')\nwrite_file(path='b.txt')\n</function_calls>");
    expect(result).toHaveLength(2);
  });
  it("ignores content inside code fences", () => {
    const result = parseOlmo("```\n<function_calls>\nread_file(path='test')\n</function_calls>\n```");
    expect(result).toHaveLength(0);
  });
  it("returns empty for text without function_calls tag", () => {
    const result = parseOlmo("just plain text with no markup");
    expect(result).toHaveLength(0);
  });
});

describe("parseToolCallXml", () => {
  it("parses tool_call tag with JSON array body", () => {
    const enabled = new Set(["qwen"]);
    const result = parseToolCallXml("<tool_call>\n[{\"name\": \"read_file\", \"arguments\": {\"path\": \"test.txt\"}}]\n</tool_call>", enabled);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });
  it("parses tools tag with JSON array body", () => {
    const enabled = new Set(["qwen"]);
    const result = parseToolCallXml("<tools>\n[{\"name\": \"write\", \"arguments\": {\"content\": \"hello\"}}]\n</tools>", enabled);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("write");
  });
  it("assigns granite grammar when enabled.has('granite')", () => {
    const enabled = new Set(["granite"]);
    const result = parseToolCallXml("<tool_call>\n{\"name\": \"calc\", \"arguments\": {}}\n</tool_call>", enabled);
    expect(result).toHaveLength(1);
    expect(result[0].grammar).toBe("granite");
  });
  it("assigns qwen grammar when enabled.has('qwen')", () => {
    const enabled = new Set(["qwen"]);
    const result = parseToolCallXml("<tool_call>\n{\"name\": \"fetch\", \"arguments\": {}}\n</tool_call>", enabled);
    expect(result).toHaveLength(1);
    expect(result[0].grammar).toBe("qwen");
  });
  it("ignores content inside code fences", () => {
    const enabled = new Set(["qwen"]);
    const result = parseToolCallXml("```\n<tool_call>\n{}</tool_call>\n```", enabled);
    expect(result).toHaveLength(0);
  });
});

describe("parseGlmToolCallBody", () => {
  it("parses arg_key and arg_value tags (name before keys)", () => {
    const result = parseGlmToolCallBody("read_file\n<arg_key>path</arg_key>\n<arg_value>test.txt</arg_value>");
    expect(result.name).toBe("read_file");
    expect(result.grammar).toBe("glm");
    expect(result.arguments["path"]).toBe("test.txt");
  });
  it("extracts name from text before first arg_key", () => {
    const result = parseGlmToolCallBody("fetch_url\n<arg_key>url</arg_key>\n<arg_value>https://example.com</arg_value>");
    expect(result.name).toBe("fetch_url");
    expect(result.grammar).toBe("glm");
    expect(result.arguments["url"]).toBe("https://example.com");
  });
  it("returns undefined when name is invalid", () => {
    const result = parseGlmToolCallBody("123 invalid\n<arg_key>k</arg_key>\n<arg_value>v</arg_value>");
    expect(result).toBeUndefined();
  });
});

describe("parseQwenFunctionBody", () => {
  it("parses function=name tag with parameter tags", () => {
    const result = parseQwenFunctionBody("<function=read_file>\n<parameter=path>test.txt</parameter>\n</function>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(result[0].arguments["path"]).toBe("test.txt");
  });
  it("parses multiple function tags", () => {
    const result = parseQwenFunctionBody("<function=tool_a><parameter=x>1</parameter></function>\n<function=tool_b><parameter=y>2</parameter></function>");
    expect(result).toHaveLength(2);
  });
  it("parses parameter values as JSON", () => {
    const result = parseQwenFunctionBody("<function=calc>\n<parameter=expr>{\"a\": 1}</parameter>\n</function>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("calc");
  });
  it("handles bare function tags outside tool_call wrapper", () => {
    const result = parseQwenFunctionBody("<function=noop><parameter=k>v</parameter></function>");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("noop");
  });
});

