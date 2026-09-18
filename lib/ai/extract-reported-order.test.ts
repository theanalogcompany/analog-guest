import { afterEach, describe, expect, it, vi } from 'vitest'
// Relative import — matches classify-message.test.ts's convention for a
// same-directory sibling module.
import { EXTRACT_REPORTED_ORDER_PROMPT_VERSION, extractReportedOrder } from './extract-reported-order'
// Real (unmocked) resolver, for the enum-dedup/max-price composition test
// below — only generateObject and the model client are mocked in this file,
// so this is the actual production resolveReportedItems, not a stand-in.
import { resolveReportedItems } from '@/lib/agent/extract-reported-order'
import type { MenuItem } from '@/lib/schemas'

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

// TAC-325: default full success object — every field the schema requires.
// Individual tests override just the field(s) under test.
function mockSuccess(overrides: Partial<Record<string, unknown>> = {}) {
  generateObjectMock.mockResolvedValue({
    object: {
      items: [{ name: 'Cortado', quantity: 1 }],
      reportTiming: 'present',
      occurredOnDate: '',
      continuesRecentVisit: true,
      ...overrides,
    },
  })
}

describe('extractReportedOrder', () => {
  it('returns items and a promptVersion on success', async () => {
    mockSuccess()

    const result = await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Croissant'],
      todayInVenueTimezone: 'Thursday, 2026-06-04',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items).toEqual([{ name: 'Cortado', quantity: 1 }])
      expect(result.data.promptVersion).toEqual(expect.any(String))
    }
  })

  it('returns an empty items array unchanged (question/future/hypothetical framing is the model\'s job)', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })

    const result = await extractReportedOrder({
      inboundBody: 'do you have cortados?',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: 'Thursday, 2026-06-04',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.items).toEqual([])
    }
  })

  it('passes the venue menu item names into the prompt', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })

    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Croissant'],
      todayInVenueTimezone: null,
    })

    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(callArgs?.prompt).toContain('Cortado')
    expect(callArgs?.prompt).toContain('Croissant')
  })

  // TAC-325: when the venue's timezone couldn't be read, the caller passes
  // null — the prompt must say so explicitly rather than silently omitting
  // any mention of "today", which would read to the model as just an
  // oversight rather than a deliberate absence.
  it('passes the venue-local today anchor into the prompt when given', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado yesterday',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: 'Thursday, 2026-06-04',
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(callArgs?.prompt).toContain('Thursday, 2026-06-04')
  })

  it('tells the model explicitly when no today anchor is available, rather than omitting it silently', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado yesterday',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(callArgs?.prompt).toContain('not available')
  })

  it('returns ok:false for empty inboundBody without calling the model', async () => {
    const result = await extractReportedOrder({
      inboundBody: '',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })
    expect(result.ok).toBe(false)
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('returns ok:true with empty items for an empty menu, without calling the model', async () => {
    // z.enum requires a non-empty tuple — this guard exists independent of
    // caller discipline (bodyMentionsMenuItem already short-circuits before
    // ever reaching this function on an empty menu).
    const result = await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: [],
      todayInVenueTimezone: null,
    })
    // TAC-325: no model call was made, so reportTiming is the conservative
    // filler — the caller writes nothing for 'vague_past', and with zero
    // items the caller never reaches the precision decision anyway.
    expect(result).toEqual({
      ok: true,
      data: {
        items: [],
        reportTiming: 'vague_past',
        occurredOnDate: '',
        continuesRecentVisit: true,
        promptVersion: expect.any(String),
      },
    })
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('constrains the name field to a z.enum of the given menu item names — behaviorally, not by inspecting Zod internals', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Croissant'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { schema?: { safeParse: (v: unknown) => { success: boolean } } }
      | undefined
    const base = { reportTiming: 'present', occurredOnDate: '', continuesRecentVisit: true }
    // Valid: a name literally in the given list.
    expect(
      callArgs?.schema?.safeParse({ ...base, items: [{ name: 'Cortado', quantity: 1 }] }).success,
    ).toBe(true)
    // Invalid: this is the exact class of bug the enum constraint closes —
    // a hallucinated or reformatted name that a bare z.string() would have
    // silently accepted (and the resolver would have silently dropped one
    // layer down, with no visibility into why).
    expect(
      callArgs?.schema?.safeParse({ ...base, items: [{ name: 'Not A Real Menu Item', quantity: 1 }] })
        .success,
    ).toBe(false)
  })

  it('dedupes repeated menu item names before building the enum (harmless either way, but avoids redundant enum entries)', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado', 'Cortado', 'Croissant'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { schema?: { safeParse: (v: unknown) => { success: boolean } } }
      | undefined
    expect(
      callArgs?.schema?.safeParse({
        items: [{ name: 'Croissant', quantity: 1 }],
        reportTiming: 'present',
        occurredOnDate: '',
        continuesRecentVisit: true,
      }).success,
    ).toBe(true)
  })

  // TAC-377 introduced the timing read on the SAME call as the extraction —
  // no second round trip. TAC-325 widens it to three states.
  it('passes the model reportTiming through to the caller', async () => {
    mockSuccess({
      items: [{ name: 'Cortado', quantity: 1 }],
      reportTiming: 'vague_past',
    })
    const result = await extractReportedOrder({
      inboundBody: 'got a cortado a while back',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: 'Thursday, 2026-06-04',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.reportTiming).toBe('vague_past')
    expect(generateObjectMock).toHaveBeenCalledTimes(1)
  })

  // TAC-325: occurredOnDate rides the same call, populated only for
  // 'specific_past_day' — the caller resolves it, this module only carries
  // it through unmodified.
  it('passes occurredOnDate through to the caller for a specific_past_day report', async () => {
    mockSuccess({ reportTiming: 'specific_past_day', occurredOnDate: '2026-06-03' })
    const result = await extractReportedOrder({
      inboundBody: 'got a cortado yesterday',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: 'Thursday, 2026-06-04',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.occurredOnDate).toBe('2026-06-03')
  })

  // TAC-325: continuesRecentVisit rides the same call too, defaulting true
  // in the prompt's own framing — this test pins that the field is read
  // through unmodified when the model says false.
  it('passes continuesRecentVisit through to the caller', async () => {
    mockSuccess({ continuesRecentVisit: false })
    const result = await extractReportedOrder({
      inboundBody: 'came back later and grabbed another cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: 'Thursday, 2026-06-04',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.continuesRecentVisit).toBe(false)
  })

  it('rejects an output with no reportTiming, and constrains it to the three values', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { schema?: { safeParse: (v: unknown) => { success: boolean } } }
      | undefined
    const base = { items: [], occurredOnDate: '', continuesRecentVisit: true }
    expect(callArgs?.schema?.safeParse({ ...base }).success).toBe(false)
    expect(callArgs?.schema?.safeParse({ ...base, reportTiming: 'yesterday' }).success).toBe(false)
    // TAC-377's retired two-state value is no longer accepted either.
    expect(callArgs?.schema?.safeParse({ ...base, reportTiming: 'past' }).success).toBe(false)
    expect(callArgs?.schema?.safeParse({ ...base, reportTiming: 'present' }).success).toBe(true)
    expect(callArgs?.schema?.safeParse({ ...base, reportTiming: 'specific_past_day' }).success).toBe(
      true,
    )
    expect(callArgs?.schema?.safeParse({ ...base, reportTiming: 'vague_past' }).success).toBe(true)
  })

  // TAC-325: occurredOnDate is a bare z.string(), never .regex() —
  // constraining it on the schema would reject the empty-string "not
  // applicable" sentinel every non-specific_past_day report returns.
  // Validity is the caller's job (lib/agent/extract-reported-order.ts).
  it('accepts any string (including empty) for occurredOnDate at the schema level', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { schema?: { safeParse: (v: unknown) => { success: boolean } } }
      | undefined
    const base = { items: [], reportTiming: 'specific_past_day', continuesRecentVisit: true }
    expect(callArgs?.schema?.safeParse({ ...base, occurredOnDate: '' }).success).toBe(true)
    expect(callArgs?.schema?.safeParse({ ...base, occurredOnDate: '2026-06-03' }).success).toBe(true)
    expect(callArgs?.schema?.safeParse({ ...base, occurredOnDate: 'not-a-date' }).success).toBe(true)
    expect(callArgs?.schema?.safeParse({ ...base }).success).toBe(false) // still required
  })

  it('requires continuesRecentVisit as a boolean', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { schema?: { safeParse: (v: unknown) => { success: boolean } } }
      | undefined
    const base = { items: [], reportTiming: 'present', occurredOnDate: '' }
    expect(callArgs?.schema?.safeParse({ ...base, continuesRecentVisit: true }).success).toBe(true)
    expect(callArgs?.schema?.safeParse({ ...base, continuesRecentVisit: false }).success).toBe(true)
    expect(callArgs?.schema?.safeParse({ ...base }).success).toBe(false)
    expect(callArgs?.schema?.safeParse({ ...base, continuesRecentVisit: 'yes' }).success).toBe(false)
  })

  // TAC-325 ruling 11: strengthens the existing "don't infer generic items"
  // instruction with an explicit rule plus a worked WRONG/RIGHT example
  // mirroring the live incident (a guest saying "a pastry" became a specific
  // priced Almond Croissant). This asserts the PROMPT carries the rule, the
  // same style this file already uses for other prompt-content assertions —
  // it cannot assert the model actually obeys it (that needs live
  // measurement, called out as a should-remeasure-after-ship item on the
  // ticket, not a solved one).
  it('instructs the model not to resolve a generic category word to a specific item', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { system?: string } | undefined
    expect(callArgs?.system).toContain('a pastry')
    expect(callArgs?.system).toContain('NOT a specific item')
  })

  // Pins the VALUE, not just "some cap". 300 was sized for `items` alone and
  // adding an output field against a static cap is the TAC-309 / TAC-367
  // truncation shape — walking this back has to delete a test that says why.
  it('allows enough output tokens for the extraction plus the timing/date/visit reads', async () => {
    mockSuccess({ items: [], reportTiming: 'vague_past' })
    await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { maxOutputTokens?: number }
      | undefined
    expect(callArgs?.maxOutputTokens).toBe(600)
  })

  it('returns ok:false with an errorCode when the model call throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('anthropic down'))

    const result = await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('anthropic down')
      expect(result.errorCode).toBe('ai_extract_reported_order_failed')
    }
  })

  it('bumped EXTRACT_REPORTED_ORDER_PROMPT_VERSION for the TAC-325 schema change', () => {
    expect(EXTRACT_REPORTED_ORDER_PROMPT_VERSION).toBe('v1.4.0')
  })

  describe('enum dedup composes correctly with the resolver max-price rule', () => {
    // Answers a specific review question: the enum sent to the model is
    // DEDUPED (12 "Olipop" rows -> 1 enum entry), but resolveReportedItems
    // groups and max-prices against the ORIGINAL, non-deduped menuItems
    // array — a completely separate variable the AI layer's dedup never
    // touches. This test exercises both real (unmocked) functions together
    // to prove the composition, not just each one in isolation.
    function makeMenuItem(overrides: Partial<MenuItem> & { name: string }): MenuItem {
      return { category: 'drinks', modifiers: [], dietary: [], isOffMenu: false, ...overrides }
    }

    it('dedupes the enum to one entry but still resolves against all underlying rows for max price', async () => {
      const duplicatedMenu = [
        makeMenuItem({ name: 'Olipop', price: 4 }),
        makeMenuItem({ name: 'Olipop', price: 5 }),
        makeMenuItem({ name: 'Olipop', price: 3.5 }),
      ]
      const menuItemNames = duplicatedMenu.map((m) => m.name) // ['Olipop','Olipop','Olipop']

      // The model can only ever return "Olipop" once per item — the enum
      // has exactly one entry regardless of how many menu rows share it.
      mockSuccess({ items: [{ name: 'Olipop', quantity: 1 }] })
      const extraction = await extractReportedOrder({
        inboundBody: 'i got an olipop',
        menuItemNames,
        todayInVenueTimezone: null,
      })
      expect(extraction.ok).toBe(true)
      if (!extraction.ok) return

      // Fed into the REAL resolver against the ORIGINAL (non-deduped, 3-row)
      // menu — the enum's deduping in the AI layer never touched this array.
      const resolved = resolveReportedItems(extraction.data.items, duplicatedMenu)
      expect(resolved).toEqual([{ name: 'Olipop', quantity: 1, unitPriceCents: 500 }])
    })
  })

  it('never uses .min()/.max() on the quantity number field (THE-157)', async () => {
    // Regression guard: a quantity of 0 or negative must not be rejected by
    // the Zod schema itself (Anthropic's structured-output validator rejects
    // min/max on number fields) — any positivity requirement belongs to the
    // caller in lib/agent/extract-reported-order.ts, not this schema.
    mockSuccess({ items: [{ name: 'Cortado', quantity: 0 }] })

    const result = await extractReportedOrder({
      inboundBody: 'i got a cortado',
      menuItemNames: ['Cortado'],
      todayInVenueTimezone: null,
    })

    expect(result.ok).toBe(true)
  })
})
