import { afterEach, describe, expect, it, vi } from 'vitest'
// Relative import — matches classify-message.test.ts's convention for a
// same-directory sibling module.
import { extractReportedOrder } from './extract-reported-order'

// Mock the AI SDK and the model client so no real Anthropic call goes out.
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

describe('extractReportedOrder', () => {
  it('returns items and a promptVersion on success', async () => {
    generateObjectMock.mockResolvedValue({
      object: { items: [{ name: 'Cortado', quantity: 1 }] },
    })

    const result = await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Croissant'],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items).toEqual([{ name: 'Cortado', quantity: 1 }])
      expect(result.data.promptVersion).toEqual(expect.any(String))
    }
  })

  it('returns an empty items array unchanged (question/future/hypothetical framing is the model\'s job)', async () => {
    generateObjectMock.mockResolvedValue({ object: { items: [] } })

    const result = await extractReportedOrder({
      inboundBody: 'do you have cortados?',
      menuItemNames: ['Cortado'],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items).toEqual([])
    }
  })

  it('passes the venue menu item names into the prompt', async () => {
    generateObjectMock.mockResolvedValue({ object: { items: [] } })

    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Croissant'],
    })

    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(callArgs?.prompt).toContain('Cortado')
    expect(callArgs?.prompt).toContain('Croissant')
  })

  it('returns ok:false for empty inboundBody without calling the model', async () => {
    const result = await extractReportedOrder({ inboundBody: '', menuItemNames: ['Cortado'] })
    expect(result.ok).toBe(false)
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('returns ok:true with empty items for an empty menu, without calling the model', async () => {
    // z.enum requires a non-empty tuple — this guard exists independent of
    // caller discipline (bodyMentionsMenuItem already short-circuits before
    // ever reaching this function on an empty menu).
    const result = await extractReportedOrder({ inboundBody: 'i got a cortado', menuItemNames: [] })
    expect(result).toEqual({ ok: true, data: { items: [], promptVersion: expect.any(String) } })
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('constrains the name field to a z.enum of the given menu item names — behaviorally, not by inspecting Zod internals', async () => {
    generateObjectMock.mockResolvedValue({ object: { items: [] } })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Croissant'],
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { schema?: { safeParse: (v: unknown) => { success: boolean } } }
      | undefined
    // Valid: a name literally in the given list.
    expect(callArgs?.schema?.safeParse({ items: [{ name: 'Cortado', quantity: 1 }] }).success).toBe(
      true,
    )
    // Invalid: this is the exact class of bug the enum constraint closes —
    // a hallucinated or reformatted name that a bare z.string() would have
    // silently accepted (and the resolver would have silently dropped one
    // layer down, with no visibility into why).
    expect(
      callArgs?.schema?.safeParse({ items: [{ name: 'Not A Real Menu Item', quantity: 1 }] })
        .success,
    ).toBe(false)
  })

  it('dedupes repeated menu item names before building the enum (harmless either way, but avoids redundant enum entries)', async () => {
    generateObjectMock.mockResolvedValue({ object: { items: [] } })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Cortado', 'Croissant'],
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { schema?: { safeParse: (v: unknown) => { success: boolean } } }
      | undefined
    expect(callArgs?.schema?.safeParse({ items: [{ name: 'Croissant', quantity: 1 }] }).success).toBe(
      true,
    )
  })

  it('returns ok:false with an errorCode when the model call throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('anthropic down'))

    const result = await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('anthropic down')
      expect(result.errorCode).toBe('ai_extract_reported_order_failed')
    }
  })

  it('never uses .min()/.max() on the quantity number field (THE-157)', async () => {
    // Regression guard: a quantity of 0 or negative must not be rejected by
    // the Zod schema itself (Anthropic's structured-output validator rejects
    // min/max on number fields) — any positivity requirement belongs to the
    // caller in lib/agent/extract-reported-order.ts, not this schema.
    generateObjectMock.mockResolvedValue({
      object: { items: [{ name: 'Cortado', quantity: 0 }] },
    })

    const result = await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
    })

    expect(result.ok).toBe(true)
  })
})
