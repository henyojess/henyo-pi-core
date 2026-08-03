/**
 * Model gate for grammar recovery.
 *
 * Only runs grammar recovery on open-model families known to print tool-call
 * grammar as text. Keeps the parsers off frontier models (Claude/GPT/Gemini)
 * that emit native tool calls and may legitimately quote grammar in prose.
 */

const MODEL_LEAKS_GRAMMAR_RE: readonly RegExp[] = [
  /glm/i,
  /kimi/i,
  /minimax/i,
  /qwen/i,
  /mistral/i,
  /llama/i,
  /granite/i,
  /olmo/i,
  /deepseek/i,
];

/** Whether grammar recovery's model gate matches the given model id. */
export function modelLeaksGrammar(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return MODEL_LEAKS_GRAMMAR_RE.some((re) => re.test(modelId));
}
