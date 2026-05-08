import { describe, expect, it } from 'vitest'
import {
  buildClassifyCritiqueUserPrompt,
  ClassifyCritiqueOutputSchema,
} from './classify-critique-pure'

describe('buildClassifyCritiqueUserPrompt', () => {
  it('renders all three blocks in order: original, corrected, critique', () => {
    const out = buildClassifyCritiqueUserPrompt({
      critique: 'too eager',
      badResponse: 'Hi! So glad you stopped by!',
      goodResponse: 'morning',
    })
    const originalIdx = out.indexOf('Hi! So glad you stopped by!')
    const correctedIdx = out.indexOf('morning')
    const critiqueIdx = out.indexOf('too eager')
    expect(originalIdx).toBeGreaterThan(-1)
    expect(correctedIdx).toBeGreaterThan(originalIdx)
    expect(critiqueIdx).toBeGreaterThan(correctedIdx)
  })

  it('labels each block with a heading the model can attend to', () => {
    const out = buildClassifyCritiqueUserPrompt({
      critique: 'x',
      badResponse: 'y',
      goodResponse: 'z',
    })
    expect(out).toContain('## Original (flagged) response')
    expect(out).toContain("## Operator's corrected version")
    expect(out).toContain('## Operator critique')
  })
})

describe('ClassifyCritiqueOutputSchema', () => {
  it('accepts edit_only without ruleText', () => {
    const parsed = ClassifyCritiqueOutputSchema.safeParse({
      kind: 'edit_only',
      reasoning: 'one-shot fix',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts edit_and_rule with ruleText', () => {
    const parsed = ClassifyCritiqueOutputSchema.safeParse({
      kind: 'edit_and_rule',
      ruleText: 'no marketing flourishes',
      reasoning: 'general pattern',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown kind', () => {
    const parsed = ClassifyCritiqueOutputSchema.safeParse({
      kind: 'something_else',
      reasoning: 'x',
    })
    expect(parsed.success).toBe(false)
  })
})
