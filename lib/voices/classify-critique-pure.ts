// Pure helpers for classify-critique. Split out so tests can load the
// prompt builder + schema without dragging the AI SDK / Anthropic client
// init through module load.
//
// Sonnet decides whether the operator's critique is a one-shot correction
// (edit_only — fix THIS message, no rule needed) or generalizes into a
// reusable anti-pattern (edit_and_rule — fix this message AND add a rule).
// When edit_and_rule, the model also synthesizes a candidate ruleText that
// the operator can override in the commit modal.

import { z } from 'zod'

export const ClassifyCritiqueOutputSchema = z.object({
  kind: z.enum(['edit_only', 'edit_and_rule']),
  ruleText: z.string().optional(),
  reasoning: z.string(),
})

export type ClassifyCritiqueOutput = z.infer<typeof ClassifyCritiqueOutputSchema>

export interface ClassifyCritiqueInput {
  critique: string
  badResponse: string
  goodResponse: string
}

export const CLASSIFY_CRITIQUE_SYSTEM = `You are an editorial assistant analyzing a critique an operator wrote about a message their AI agent generated.

Your job is to decide whether the critique is a one-shot correction (edit_only) or generalizes into a reusable rule the agent should follow on every future message (edit_and_rule).

Heuristic:
- edit_only: the critique is specific to this exchange. The fix matters once, here. Examples: "wrong perk mentioned," "missed that the guest said they're vegetarian," "factual error about hours."
- edit_and_rule: the critique describes a pattern the agent should avoid in general. Examples: "too eager — drop the exclamation point and the 'so glad you stopped by!' opener; we never sound like that," "stop using 'pairs beautifully' — marketing language."

When edit_and_rule, write the rule text in the operator's voice — concrete and imperative. The rule should describe what NOT to do or what to do instead. Aim for one or two sentences. Don't reference this specific message.`

export function buildClassifyCritiqueUserPrompt(input: ClassifyCritiqueInput): string {
  return [
    '## Original (flagged) response',
    input.badResponse,
    '',
    "## Operator's corrected version",
    input.goodResponse,
    '',
    '## Operator critique',
    input.critique,
    '',
    'Decide whether this critique is edit_only or edit_and_rule. If edit_and_rule, synthesize a candidate ruleText.',
  ].join('\n')
}
