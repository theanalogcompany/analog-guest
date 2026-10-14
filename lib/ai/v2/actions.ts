import { z } from 'zod'
import { ACTION_TYPES } from '@/lib/policy/schema'

// The v2 generation output contract: guest-visible bubbles plus, rarely, the
// structured carriers for anything consequential. Nothing else rides the
// latency path - memory and state maintenance belong to the post-turn
// assessor (decision 0009; output tokens dominate latency at ~40 tok/s).
//
// LLM-OUTPUT SCHEMA RULES APPLY (lib/ai/CLAUDE.md): no .min()/.max() on
// numbers, no .max() on arrays; cap with .slice() after the call. Optional
// budget: `actions` is the only optional field in the tree (1 of 22).
//
// `actions` is OPTIONAL AND NORMALLY ABSENT, deliberately: an absent field
// costs zero output tokens on the common turn. The template's hard-lines
// section states the contract - a commitment exists only if its action is
// declared - and the comp_leak/promise_leak policies are the backstop for
// prose that violates it.

/**
 * One consequential thing the reply does. Every field required (free against
 * the optional cap); `detail` carries the specifics as prose and the
 * operator card renders it verbatim.
 */
export const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  /** What exactly: "a replacement almond croissant", "hold the window table until 3pm Friday". */
  detail: z.string(),
  /** Why this turn warranted it: "order arrived stale, guest sent a photo". */
  reason: z.string(),
})
export type Action = z.infer<typeof ActionSchema>

export const GenerationOutputSchema = z.object({
  /**
   * The actual text bubbles, in send order. Capped after the call with
   * .slice(0, MAX_MESSAGES) - never maxItems.
   *
   * SPLITTING IS LEGISLATED AS OF v2.20.0, and this comment used to say the
   * opposite ("the model owns splitting; bubble quality is judged
   * per-response, not legislated"). The owner's `# Texting style` now asks for
   * 1 to 3 messages, puts anything past the direct answer in its own message,
   * and bans a trailing period. The Economy axis still scores it; the prompt
   * is no longer silent on it. `MAX_MESSAGES` is 4, so the contract still
   * permits one more bubble than the prompt asks for.
   *
   * `.min(1)` BINDS THE MODEL, NOT THE RESULT. `# Rules` tells it to respond
   * nothing on an opt-out, which this floor makes unrepresentable, so
   * generate.ts drops blank bubbles after the slice and a turn can come back
   * with zero messages. Anything reading this output has to handle an empty
   * array.
   */
  messages: z.array(z.string()).min(1),
  actions: z.array(ActionSchema).optional(),
})
export type GenerationOutput = z.infer<typeof GenerationOutputSchema>

/** Post-call cap; the dispatch layer refuses more bubbles than this. */
export const MAX_MESSAGES = 4

export function declaredActionTypes(output: GenerationOutput): string[] {
  return (output.actions ?? []).map((a) => a.type)
}
