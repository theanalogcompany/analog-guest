import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { verifyMechanicOffer } from './verify-mechanic-offer'
import type { VerifyMechanicOfferGatedMechanic } from './types'

// Mock the AI SDK and the model client so no real Anthropic call goes out.
// Same pattern as verify-grounding.test.ts.
const generateObjectMock = vi.fn()
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}))
vi.mock('./client', () => ({
  getClassificationModel: () => 'mock-model',
}))

afterEach(() => {
  generateObjectMock.mockReset()
})

function makeMechanics(
  overrides: Partial<VerifyMechanicOfferGatedMechanic>[] = [],
): VerifyMechanicOfferGatedMechanic[] {
  if (overrides.length === 0) {
    return [
      {
        id: 'mech-1',
        name: 'Referral Surprise',
        rewardDescription: 'A complimentary item for the first-time guest.',
        qualification: 'A regular brings a friend in for the first time.',
      },
    ]
  }
  return overrides.map((o, i) => ({
    id: `mech-${i + 1}`,
    name: 'Mechanic',
    rewardDescription: null,
    qualification: null,
    ...o,
  }))
}

describe('verifyMechanicOffer', () => {
  it('returns offersGatedMechanic + mechanicId + promptVersion on a flagged offer', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        offersGatedMechanic: true,
        mechanicId: 'mech-1',
        reasoning: 'reply promises a complimentary item matching Referral Surprise',
      },
    })

    const result = await verifyMechanicOffer({
      replyBody: 'since your friend came in with you, something special is on us',
      eligibleGatedMechanics: makeMechanics(),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.offersGatedMechanic).toBe(true)
      expect(result.data.mechanicId).toBe('mech-1')
      expect(result.data.promptVersion).toEqual(expect.any(String))
    }
  })

  it('returns offersGatedMechanic=false and mechanicId="none" for a clean reply', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        offersGatedMechanic: false,
        mechanicId: 'none',
        reasoning: 'reply only answers a menu question',
      },
    })

    const result = await verifyMechanicOffer({
      replyBody: 'yeah, oat and almond',
      eligibleGatedMechanics: makeMechanics(),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.offersGatedMechanic).toBe(false)
      expect(result.data.mechanicId).toBe('none')
    }
  })

  // [CODE REVIEW] Nothing structurally stops the model from returning
  // offersGatedMechanic=true with mechanicId="none" — the schema doesn't
  // cross-validate the two fields. An earlier version of the caller
  // (verifyMechanicOfferStage) treated this as 'clean' — a false negative,
  // exactly the failure mode this backstop exists to prevent. The
  // safety-relevant boolean must survive; only the identifying detail is
  // patched, mirroring verify-grounding.ts's identical defensive
  // substitution for the analogous ambiguous shape.
  it('substitutes a placeholder mechanicId when the model flags true but cannot identify which mechanic', async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        offersGatedMechanic: true,
        mechanicId: 'none',
        reasoning: 'reply promises something but multiple gated mechanics are eligible',
      },
    })

    const result = await verifyMechanicOffer({
      replyBody: 'something special is coming your way',
      eligibleGatedMechanics: makeMechanics([{ id: 'mech-1' }, { id: 'mech-2' }]),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.offersGatedMechanic).toBe(true)
    expect(result.data.mechanicId).not.toBe('none')
    expect(result.data.mechanicId).toMatch(/did not specify/)
  })

  it('rejects an empty replyBody without calling the model', async () => {
    const result = await verifyMechanicOffer({
      replyBody: '',
      eligibleGatedMechanics: makeMechanics(),
    })
    expect(result).toEqual({ ok: false, error: 'invalid_input' })
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('rejects an empty eligibleGatedMechanics array without calling the model', async () => {
    const result = await verifyMechanicOffer({
      replyBody: 'hey there',
      eligibleGatedMechanics: [],
    })
    expect(result).toEqual({ ok: false, error: 'no_eligible_gated_mechanics' })
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('returns ok:false with an errorCode when generateObject throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('model unavailable'))

    const result = await verifyMechanicOffer({
      replyBody: 'hey there',
      eligibleGatedMechanics: makeMechanics(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('model unavailable')
      expect(result.errorCode).toBe('ai_verify_mechanic_offer_failed')
    }
  })

  it('builds the mechanicId enum per-call from the actual eligible id set, plus "none"', async () => {
    generateObjectMock.mockResolvedValue({
      object: { offersGatedMechanic: false, mechanicId: 'none', reasoning: '' },
    })

    await verifyMechanicOffer({
      replyBody: 'hey there',
      eligibleGatedMechanics: makeMechanics([{ id: 'abc-1' }, { id: 'abc-2' }]),
    })

    const args = generateObjectMock.mock.calls[0][0] as { schema: z.ZodTypeAny }
    // The schema is a Zod object; assert indirectly via its JSON Schema
    // projection so this test doesn't depend on Zod's internal shape.
    const jsonSchema = z.toJSONSchema(args.schema) as {
      properties?: { mechanicId?: { enum?: string[] } }
    }
    expect(jsonSchema.properties?.mechanicId?.enum).toEqual(['abc-1', 'abc-2', 'none'])
  })

  it('includes the reply body and every eligible mechanic in the prompt', async () => {
    generateObjectMock.mockResolvedValue({
      object: { offersGatedMechanic: false, mechanicId: 'none', reasoning: '' },
    })

    await verifyMechanicOffer({
      replyBody: 'the exact reply text',
      eligibleGatedMechanics: makeMechanics([
        { id: 'mech-1', name: 'Referral Surprise', rewardDescription: 'a treat' },
      ]),
    })

    const args = generateObjectMock.mock.calls[0][0] as { prompt: string }
    expect(args.prompt).toContain('the exact reply text')
    expect(args.prompt).toContain('Referral Surprise')
    expect(args.prompt).toContain('a treat')
  })
})
