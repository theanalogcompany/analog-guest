import { generateObject } from 'ai'
import { getGenerationModel } from '@/lib/ai/client'
import {
  buildClassifyCritiqueUserPrompt,
  type ClassifyCritiqueInput,
  type ClassifyCritiqueOutput,
  ClassifyCritiqueOutputSchema,
  CLASSIFY_CRITIQUE_SYSTEM,
} from './classify-critique-pure'

export type {
  ClassifyCritiqueInput,
  ClassifyCritiqueOutput,
} from './classify-critique-pure'

export type ClassifyCritiqueResult =
  | { ok: true; data: ClassifyCritiqueOutput }
  | { ok: false; error: string }

/**
 * Decide whether the operator's critique is a one-shot fix (edit_only) or
 * generalizes into a reusable anti-pattern (edit_and_rule). The commit
 * modal renders this as advisory — operator can override both `kind` and
 * `ruleText` before commit fires.
 *
 * Temperature 0.3 — same idempotent-extraction temp the rest of lib/ai
 * uses for structured output that should converge across runs.
 */
export async function classifyCritique(
  input: ClassifyCritiqueInput,
): Promise<ClassifyCritiqueResult> {
  try {
    const { object } = await generateObject({
      model: getGenerationModel(),
      system: CLASSIFY_CRITIQUE_SYSTEM,
      prompt: buildClassifyCritiqueUserPrompt(input),
      schema: ClassifyCritiqueOutputSchema,
      temperature: 0.3,
      maxOutputTokens: 400,
    })
    return { ok: true, data: object }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}
