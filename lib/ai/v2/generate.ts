import { generateObject } from 'ai'
import { anthropicV2Model } from '@/lib/ai/client'
import {
  resolveV2Effort,
  resolveV2ModelProfile,
  V2_GENERATE_MAX_OUTPUT_TOKENS,
  V2_GENERATE_TEMPERATURE,
  V2_MODEL_PROFILES,
  type V2Effort,
  type V2EffortRequest,
  type V2ModelKey,
} from './model-call'
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

/**
 * Thinking tokens, dug out of the provider's RAW usage.
 *
 * NOT `usage.reasoningTokens`. That field is the obvious one, it is typed, it
 * is named exactly right, and it is `undefined` on every Anthropic call
 * checked - while the real number sits at
 * `usage.raw.output_tokens_details.thinking_tokens`. A reader reaching for the
 * well-named field concludes no thinking happened.
 *
 * Returns null when the provider reported no breakdown at all, which is a
 * different fact from zero: claude-sonnet-4-6 omits the key entirely at every
 * effort level, while claude-haiku-5-5 reports a real 0 below `max`.
 */
export function thinkingTokensOf(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const raw = (usage as { raw?: unknown }).raw
  if (typeof raw !== 'object' || raw === null) return null
  const details = (raw as { output_tokens_details?: unknown })
    .output_tokens_details
  if (typeof details !== 'object' || details === null) return null
  const t = (details as { thinking_tokens?: unknown }).thinking_tokens
  return typeof t === 'number' ? t : null
}

/**
 * Per-call overrides for the model and its sampling parameters. EMPTY in
 * production - every field here exists so a human can experiment in the
 * playground, and the defaults are what production sends.
 *
 * `modelKey` rather than a model id: the id alone is not enough to make the
 * call, because which parameters a model tolerates is part of its profile
 * (./model-call.ts). Passing an id would let a caller pair one model's id
 * with another's parameters.
 */
export interface V2GenerateOptions {
  modelKey?: V2ModelKey
  /** Omit for `V2_DEFAULT_EFFORT`; `'none'` to send no effort at all. */
  effort?: V2EffortRequest
  maxOutputTokens?: number
}

export interface V2GenerationResult {
  output: GenerationOutput
  usage: V2Usage
  durationMs: number
  /**
   * What was actually sent, so a report names the call and not the default.
   *
   * FOR A DIRECT CALLER. `runTurn` builds its own `modelCall` from the same
   * inputs before the call (a failed generation must still say which model
   * failed), and takes only `temperature` from here - the one field it cannot
   * derive without duplicating the profile's rules. An ablation harness
   * calling this function straight (`.claude/skills/ablate-a-bad-reply` loops
   * on composePrompt + generateV2Reply, never runTurn) has no trace at all,
   * and this is its record of the arm.
   */
  call: {
    model: string
    effort: V2Effort | null
    maxOutputTokens: number
    /** null when the model rejects the parameter, so it was not sent. */
    temperature: number | null
  }
  /** null when the provider reported no breakdown - not the same as 0. */
  thinkingTokens: number | null
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
  options: V2GenerateOptions = {},
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
    // Resolved ONCE per call, so the model and the parameters it tolerates
    // cannot come from two different reads of the switch. An explicit
    // `modelKey` wins over the environment - that is the playground asking for
    // a specific model, which is more specific than a server default.
    const profile =
      options.modelKey === undefined
        ? resolveV2ModelProfile()
        : V2_MODEL_PROFILES[options.modelKey]
    const maxOutputTokens =
      options.maxOutputTokens ?? V2_GENERATE_MAX_OUTPUT_TOKENS
    // An EXPLICIT effort this model rejects is REFUSED rather than silently
    // dropped: sending it anyway fails the call at the provider and reports an
    // experiment as a model failure, and dropping it silently runs a different
    // experiment than the one asked for.
    //
    // THE DEFAULT IS THE OPPOSITE DIRECTION and deliberately so - it degrades
    // to no effort. A refusal is the right answer to a human's typo and the
    // wrong answer to a constant: a default no profile accepted would take
    // every v2 turn down at once.
    if (
      options.effort !== undefined &&
      options.effort !== 'none' &&
      !profile.allowedEfforts.includes(options.effort)
    )
      return {
        ok: false,
        error: `${profile.id} does not accept effort "${options.effort}" (accepts: ${profile.allowedEfforts.join(', ')})`,
      }
    const effort = resolveV2Effort(profile, options.effort)
    const { object, usage } = await generateObject({
      model: anthropicV2Model(profile),
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
      maxOutputTokens,
      // Per-model, and WHY is on V2ModelProfile in ./model-call.ts rather
      // than here - the reasons are about what each model rejects, which
      // belongs with the profile that records it.
      ...(profile.sendsTemperature
        ? { temperature: V2_GENERATE_TEMPERATURE }
        : {}),
      // ONE providerOptions object. These were two separate conditional
      // spreads while `effort` did not exist, and a second spread of the same
      // key would have silently replaced the first rather than merging - so a
      // model needing `outputFormat` would have lost it the moment an effort
      // was set.
      ...(profile.forcesOutputFormat || effort !== null
        ? {
            providerOptions: {
              anthropic: {
                ...(profile.forcesOutputFormat
                  ? { structuredOutputMode: 'outputFormat' as const }
                  : {}),
                ...(effort !== null ? { effort } : {}),
              },
            },
          }
        : {}),
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
            )
            // BLANK BUBBLES DROPPED, so a turn can send nothing (v2.20.0,
            // owner-ruled 2026-10-13). `# Rules` tells the model to respond
            // nothing when a guest asks to stop messaging them, and
            // GenerationOutputSchema.messages is `.min(1)`, so the only
            // compliant way to obey that is an empty string - which the gate
            // would then auto-send, because `opt_out_request` is exempt from
            // queueing (POLICY_EXEMPT_SITUATIONS).
            //
            // NOT A GUARANTEE, and the schema floor is why: nothing can make
            // the model return an empty array, and a model answering "no
            // problem, you won't hear from us" instead of nothing is still
            // one bubble. This removes the empty-bubble send and nothing more.
            //
            // Downstream must accept zero messages. Today's only readers are
            // the playground, the harnesses and the judge; phase 6's dispatch
            // has to treat an empty reply as "send nothing", never as a
            // generation failure.
            .filter((m) => m.trim() !== ''),
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
        // WHAT WAS SENT, not what the defaults are. A trace that reported the
        // constants would be right until the first override and wrong after,
        // and the whole point of the overrides is comparing turns.
        call: {
          model: profile.id,
          effort,
          maxOutputTokens,
          temperature: profile.sendsTemperature
            ? V2_GENERATE_TEMPERATURE
            : null,
        },
        thinkingTokens: thinkingTokensOf(usage),
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
