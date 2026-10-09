import { generateObject } from 'ai'
import { getGenerationModel } from '@/lib/ai/client'
import type { AIResult } from '@/lib/ai/types'
import {
  GenerationOutputSchema,
  MAX_MESSAGES,
  type GenerationOutput,
} from './actions'
import type { ComposedPrompt } from './compose'
import {
  replaceDashesWithPeriod,
  stripEitherOrQuestion,
  stripFullStop,
} from './normalize-output'

// The v2 generation call: composed prompt in, {messages, actions?} out.
//
// Cache control rides the composer's breakpoint flags - TWO of them now, one
// after the venue block and one on the last transcript turn. The header here
// used to say "both system blocks are stable per venue", which was FALSE:
// block 2 ended with per-turn retrieval, and that single sentence is why
// nobody checked a cache being re-written every turn and read on none.
// Measured when it was found (Le Mil's, cold, two turns): write 6,326 then
// 6,267, reuse 0. After moving retrieval out of the system blocks: write
// 6,133 then reuse 6,133. Verify a claim like this against
// providerMetadata.anthropic.usage, never against the layout read back off
// the code.
//
// The 1h ttl carries over from the measured v1 traffic shape
// (generate-message.ts header, 2026-09-23 run).
//
// Consecutive user turns (situation brief, then the guest's messages) are
// legal: @ai-sdk/anthropic merges same-role runs into content blocks, so the
// guest's words stay verbatim in their own block.

export const V2_GENERATE_MAX_OUTPUT_TOKENS = 1_000

// Lowest (owner call, 2026-10-05). Unset, the provider default (1.0) applied
// and regression runs showed the tail of that distribution: register drift
// and question stacking. 0 picks the head of the distribution every time;
// per-guest variety comes from the situation brief differing, not sampling.
export const V2_GENERATE_TEMPERATURE = 0

/**
 * The SDK's `usage` passed through WHOLE, never picked apart here.
 *
 * It used to be `{inputTokens, outputTokens}`, which silently dropped both
 * cache buckets - so the one number that says whether the prompt cache is
 * working could not be read downstream at all, while the layout that broke it
 * sat unnoticed for days. `toAgentUsage` (lib/observability) owns the
 * arithmetic, and it needs the fields this shape preserves.
 *
 * THE TRAP, documented at `AgentUsage`: `inputTokens` is NOT the uncached
 * input. It is `noCache + cacheRead + cacheWrite`. Never chart it as "input"
 * and never derive a hit rate by subtracting it from something.
 */
export interface V2Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number | null
    cacheWriteTokens?: number | null
  } | null
}

export interface V2GenerationResult {
  output: GenerationOutput
  usage: V2Usage
  durationMs: number
}

/**
 * Cache READ tokens over total input tokens, 0 to 1, or null when the
 * provider reported no input at all.
 *
 * A RATE, not a count, because the counts alone cannot answer "is the cache
 * working" without knowing the prompt size - and prompt size moves every time
 * a section is added. 0 on a first turn is correct and not a fault: there was
 * nothing to read yet.
 */
export function cacheHitRate(usage: V2Usage): number | null {
  const total = usage.inputTokens ?? 0
  if (total <= 0) return null
  return (usage.cachedInputTokens ?? 0) / total
}

export async function generateV2Reply(
  prompt: ComposedPrompt,
): Promise<AIResult<V2GenerationResult>> {
  const started = Date.now()
  try {
    // One definition of a breakpoint, applied to system blocks and turns
    // alike. The turn breakpoint is NOT decoration: compose.ts puts it on the
    // last transcript turn, and if this call dropped it the composer would be
    // claiming a cached transcript that nothing ever cached.
    const cacheControl = {
      anthropic: {
        cacheControl: { type: 'ephemeral' as const, ttl: '1h' },
      },
    }
    const { object, usage } = await generateObject({
      model: getGenerationModel(),
      messages: [
        ...prompt.system.map((block) => ({
          role: 'system' as const,
          content: block.text,
          ...(block.cacheBreakpoint ? { providerOptions: cacheControl } : {}),
        })),
        ...prompt.turns.map((t) => ({
          role: t.role,
          content: t.text,
          ...(t.cacheBreakpoint ? { providerOptions: cacheControl } : {}),
        })),
      ],
      schema: GenerationOutputSchema,
      maxOutputTokens: V2_GENERATE_MAX_OUTPUT_TOKENS,
      temperature: V2_GENERATE_TEMPERATURE,
    })
    return {
      ok: true,
      data: {
        output: {
          messages: object.messages
            .slice(0, MAX_MESSAGES)
            // Dashes first: it is the one that can introduce a sentence
            // break, and the two strips after it read sentence boundaries.
            .map((m) =>
              stripFullStop(stripEitherOrQuestion(replaceDashesWithPeriod(m))),
            ),
          actions: object.actions,
        },
        // Whole, not picked apart - see V2Usage.
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedInputTokens: usage.cachedInputTokens,
          inputTokenDetails: usage.inputTokenDetails,
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
