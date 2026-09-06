/**
 * Compaction retry guard.
 *
 * Some models (observed: qwen3.8-27b via apollo-8002) "narrate" tool calls in
 * the tool-free summarization request. Pi treats any toolCall block in the
 * summary response as a hard failure ("Summarization attempted to call a
 * tool"), so auto-compaction dies and the session eventually runs out of
 * context.
 *
 * This extension takes over summary generation on session_before_compact:
 * - strict plain-text system prompt
 * - reasoning off (saves output budget, fewer narration artifacts)
 * - up to MAX_ATTEMPTS retries with targeted repair feedback
 *   (tool call emitted / empty text / truncated response / API error)
 * - falls back to pi's default compaction if it can't get clean text
 *
 * Config-gated: registered by `src/index.ts` when `henyo.compactionRetry`
 * is true (default off). `/reload` applies changes.
 */
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { convertToLlm, serializeConversation } from '@earendil-works/pi-coding-agent';

const MAX_ATTEMPTS = 3;
// ~0.8 x reserveTokens (21504) - same budget pi's default uses now
const MAX_TOKENS = 17000;

const PLAIN_TEXT_RULE =
  'Output plain markdown text only. Do NOT output tool calls, JSON tool blocks, or anything that looks like a tool invocation. Never continue the conversation.';

// Same structured format pi's built-in summarization uses, so future
// compactions merge cleanly with previous summaries.
const SUMMARY_FORMAT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.

${PLAIN_TEXT_RULE}`;

const SYSTEM_PROMPT = `You are a conversation summarizer. ${PLAIN_TEXT_RULE} Your only output is the summary document itself.`;

function buildPrompt(
  conversationText: string,
  previousSummary: string | undefined,
  repairNote: string | undefined,
): string {
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    prompt += `Update this existing structured summary with the new conversation above. Preserve all still-relevant information, merge new progress and decisions, and keep the EXACT format below.\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  if (repairNote) {
    prompt += repairNote + '\n\n';
  }
  return prompt + SUMMARY_FORMAT;
}

export function compactionRetryExtension(pi: ExtensionAPI): void {
  pi.on('session_before_compact', async (event, ctx) => {
    const model = ctx.model;
    if (!model) return; // no model: let the default path handle it
    const { preparation, signal } = event;
    const {
      messagesToSummarize,
      turnPrefixMessages,
      firstKeptEntryId,
      tokensBefore,
      previousSummary,
    } = preparation;

    const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
    if (allMessages.length === 0) return;
    const conversationText = serializeConversation(convertToLlm(allMessages));

    let repairNote: string | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) return;
      ctx.ui.notify(`Compaction: summary attempt ${attempt}/${MAX_ATTEMPTS} (${model.id})`, 'info');
      let response: Awaited<ReturnType<typeof ctx.modelRegistry.complete>>;
      try {
        response = await ctx.modelRegistry.complete(
          model,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [
              {
                role: 'user' as const,
                content: [
                  {
                    type: 'text' as const,
                    text: buildPrompt(conversationText, previousSummary, repairNote),
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          // fresh UUID per call — cache isolation (cacheRetention: 'none')
          {
            maxTokens: MAX_TOKENS,
            signal,
            cacheRetention: 'none',
            sessionId: randomUUID(),
            reasoning: 'off',
          },
        );
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (signal?.aborted) return;
        ctx.ui.notify(`Compaction attempt ${attempt} errored: ${lastError}`, 'warning');
        repairNote = `Your previous response could not be processed (${lastError}). ${PLAIN_TEXT_RULE}`;
        continue;
      }

      const blocks = response.content;
      const toolCalls = blocks.filter((b) => b.type === 'toolCall');
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      if (toolCalls.length > 0) {
        ctx.ui.notify(
          `Compaction attempt ${attempt}: model emitted ${toolCalls.length} tool call(s); retrying`,
          'warning',
        );
        repairNote = `Your previous response contained tool calls, which is forbidden here. ${PLAIN_TEXT_RULE} Respond again with ONLY the summary document.`;
        continue;
      }
      if (!text) {
        ctx.ui.notify(`Compaction attempt ${attempt}: empty response; retrying`, 'warning');
        repairNote = `Your previous response contained no text. ${PLAIN_TEXT_RULE}`;
        continue;
      }
      if (response.stopReason === 'length') {
        ctx.ui.notify(
          `Compaction attempt ${attempt}: response truncated; retrying with a conciseness note`,
          'warning',
        );
        repairNote =
          'Your previous response was truncated before completion. Write a more concise summary and make sure it completes.';
        continue;
      }

      // Clean summary - let pi append the compaction entry
      return {
        compaction: {
          summary: text,
          firstKeptEntryId,
          tokensBefore,
          usage: response.usage,
        },
      };
    }

    ctx.ui.notify(
      `Compaction: giving up after ${MAX_ATTEMPTS} attempts${lastError ? ` (last error: ${lastError})` : ''}. Try /compact again, or /tree to jump to an earlier point.`,
      'error',
    );
    return; // fall back to pi's default compaction
  });
}
