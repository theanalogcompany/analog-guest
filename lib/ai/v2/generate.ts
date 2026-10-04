import { generateObject } from 'ai'
import { getGenerationModel } from '@/lib/ai/client'
import type { AIResult } from '@/lib/ai/types'
import {
  GenerationOutputSchema,
  MAX_MESSAGES,
  type GenerationOutput,
} from './actions'
import type { ComposedPrompt } from './compose'

// The v2 generation call: composed prompt in, {messages, actions?} out.
// Cache control rides the composer's breakpoint flags - both system blocks
// are stable per venue, so the prefix caches through the second block; the
// 1h ttl carries over from the measured v1 traffic shape (generate-message.ts
// header, 2026-09-23 run).
//
// Consecutive user turns (situation brief, then the guest's messages) are
// legal: @ai-sdk/anthropic merges same-role runs into content blocks, so the
// guest's words stay verbatim in their own block.

export const V2_GENERATE_MAX_OUTPUT_TOKENS = 1_000

export interface V2GenerationResult {
  output: GenerationOutput
  usage: { inputTokens?: number; outputTokens?: number }
  durationMs: number
}

export async function generateV2Reply(
  prompt: ComposedPrompt,
): Promise<AIResult<V2GenerationResult>> {
  const started = Date.now()
  try {
    const { object, usage } = await generateObject({
      model: getGenerationModel(),
      messages: [
        ...prompt.system.map((block) => ({
          role: 'system' as const,
          content: block.text,
          ...(block.cacheBreakpoint
            ? {
                providerOptions: {
                  anthropic: {
                    cacheControl: { type: 'ephemeral' as const, ttl: '1h' },
                  },
                },
              }
            : {}),
        })),
        ...prompt.turns.map((t) => ({ role: t.role, content: t.text })),
      ],
      schema: GenerationOutputSchema,
      maxOutputTokens: V2_GENERATE_MAX_OUTPUT_TOKENS,
    })
    return {
      ok: true,
      data: {
        output: {
          messages: object.messages.slice(0, MAX_MESSAGES),
          actions: object.actions,
        },
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        durationMs: Date.now() - started,
      },
    }
  } catch (e) {
    return {
      ok: false,
      error: `v2 generation failed: ${e instanceof Error ? e.message : String(e)}`,
      errorCode: 'v2_generation_failed',
    }
  }
}
