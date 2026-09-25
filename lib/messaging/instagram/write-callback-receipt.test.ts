// TAC-516 follow-up: the one place a receipt is written and a replay judged.
//
// The load-bearing rule here is that a FAILED repeat lookup is not "no
// earlier delivery": collapsing the two records a replay as a first delivery,
// which is the invisibility the table exists to remove.

import { formatWithOptions } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recordMock = vi.fn()
const consequentialSpy = vi.fn()
vi.mock('./callback-receipts', async () => {
  const actual = await vi.importActual<typeof import('./callback-receipts')>('./callback-receipts')
  return {
    ...actual,
    recordCallbackReceipt: (...a: unknown[]) => recordMock(...a),
    // The real predicate, wrapped so the relay decision can be shown to come
    // from it rather than from a second copy of the rule living here.
    isConsequentialRepeat: (input: Parameters<typeof actual.isConsequentialRepeat>[0]) => {
      consequentialSpy(input)
      return actual.isConsequentialRepeat(input)
    },
  }
})

const replayedMock = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramCallbackReplayed: (...a: unknown[]) => replayedMock(...a),
}))

import { writeCallbackReceipt } from './write-callback-receipt'

const CLIENT = {} as never
const FINGERPRINT = 'b'.repeat(64)
const ACCOUNT = '17841479626987104'
const NOW = new Date('2026-09-25T10:00:00.000Z')
const EARLIER = {
  receiptId: 'receipt-1',
  receivedAt: new Date('2026-09-25T09:00:00.000Z'),
  outcome: 'applied' as const,
}

const logged: unknown[][] = []
function loggedText(): string {
  return logged
    .map((args) =>
      formatWithOptions(
        { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, breakLength: Infinity },
        ...args,
      ),
    )
    .join('\n')
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    callback: 'data_deletion' as const,
    fingerprint: FINGERPRINT,
    earlier: { ok: true as const, earlier: null },
    payload: { userId: ACCOUNT, issuedAt: 1790000000 },
    venueId: '11111111-1111-4111-8111-111111111111',
    outcome: 'applied' as const,
    rowsAffected: 2,
    confirmationCode: 'code-1',
    now: NOW,
    logPrefix: '[test]',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  logged.length = 0
  recordMock.mockResolvedValue({ ok: true, receiptId: 'receipt-2' })
  replayedMock.mockResolvedValue(undefined)
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writeCallbackReceipt', () => {
  it('records a first delivery with no repeat link, and raises nothing', async () => {
    await writeCallbackReceipt(CLIENT, input())
    expect(recordMock).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ repeatOfReceiptId: null, rowsAffected: 2 }),
    )
    expect(replayedMock).not.toHaveBeenCalled()
  })

  it('converts Meta\'s issued_at from seconds to a real instant', async () => {
    await writeCallbackReceipt(CLIENT, input())
    const [, row] = recordMock.mock.calls[0] as [unknown, { payloadIssuedAt: Date | null }]
    expect(row.payloadIssuedAt?.toISOString()).toBe(new Date(1790000000 * 1000).toISOString())
  })

  it('carries a missing issued_at through as null', async () => {
    await writeCallbackReceipt(CLIENT, input({ payload: { userId: ACCOUNT, issuedAt: null } }))
    const [, row] = recordMock.mock.calls[0] as [unknown, { payloadIssuedAt: Date | null }]
    expect(row.payloadIssuedAt).toBeNull()
  })

  it('links a repeat to the delivery it repeats', async () => {
    await writeCallbackReceipt(CLIENT, input({ earlier: { ok: true, earlier: EARLIER } }))
    expect(recordMock).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ repeatOfReceiptId: 'receipt-1' }),
    )
  })

  // THE RULE THIS FILE EXISTS FOR. A failed lookup must not be recorded as a
  // first delivery, and must not silently skip the receipt either: an
  // unknown repeat status beats no row at all.
  it('still records a receipt when the repeat check failed, and says so', async () => {
    await writeCallbackReceipt(CLIENT, input({ earlier: { ok: false, error: 'timeout' } }))
    expect(recordMock).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ repeatOfReceiptId: null }),
    )
    expect(loggedText()).toContain('instagram_callback_repeat_check_failed')
  })

  // THE ROW HAS TO SAY IT, not just the log. repeat_of_receipt_id is null for
  // a first delivery AND for a failed check, so without this flag a replay
  // arriving during a database blip reads as a first delivery forever after —
  // the exact invisibility this table exists to remove. A surviving mutant
  // found this: the code had a variable for it and never stored it.
  it('marks the row unchecked when the repeat lookup failed', async () => {
    await writeCallbackReceipt(CLIENT, input({ earlier: { ok: false, error: 'timeout' } }))
    expect(recordMock).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ repeatChecked: false }),
    )
  })

  it('marks the row checked when the lookup ran and found nothing', async () => {
    await writeCallbackReceipt(CLIENT, input())
    expect(recordMock).toHaveBeenCalledWith(CLIENT, expect.objectContaining({ repeatChecked: true }))
  })

  it('marks the row checked when the lookup ran and found a repeat', async () => {
    await writeCallbackReceipt(CLIENT, input({ earlier: { ok: true, earlier: EARLIER } }))
    expect(recordMock).toHaveBeenCalledWith(CLIENT, expect.objectContaining({ repeatChecked: true }))
  })

  it('never claims a replay it could not check for', async () => {
    await writeCallbackReceipt(CLIENT, input({ earlier: { ok: false, error: 'timeout' } }))
    expect(replayedMock).not.toHaveBeenCalled()
  })

  describe('the replay alert', () => {
    it('records every repeat, and relays only the one that redacted live rows', async () => {
      await writeCallbackReceipt(CLIENT, input({ earlier: { ok: true, earlier: EARLIER } }))
      expect(replayedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          callback: 'data_deletion',
          instagramAccountId: ACCOUNT,
          earlierReceiptId: 'receipt-1',
          rowsAffected: 2,
        }),
        { relayToSlack: true },
      )
    })

    it('records a repeated deauthorize without relaying it', async () => {
      await writeCallbackReceipt(
        CLIENT,
        input({ callback: 'deauthorize', rowsAffected: null, confirmationCode: null, earlier: { ok: true, earlier: EARLIER } }),
      )
      expect(replayedMock).toHaveBeenCalledWith(expect.anything(), { relayToSlack: false })
    })

    it('records a deletion replay that found nothing left without relaying it', async () => {
      await writeCallbackReceipt(
        CLIENT,
        input({ rowsAffected: 0, earlier: { ok: true, earlier: EARLIER } }),
      )
      expect(replayedMock).toHaveBeenCalledWith(expect.anything(), { relayToSlack: false })
    })

    // The relay decision must come from the shared predicate, not from a
    // second copy of the rule here that can drift from the routes'.
    it('asks isConsequentialRepeat rather than deciding for itself', async () => {
      await writeCallbackReceipt(CLIENT, input({ earlier: { ok: true, earlier: EARLIER } }))
      expect(consequentialSpy).toHaveBeenCalledWith({
        callback: 'data_deletion',
        isRepeat: true,
        rowsAffected: 2,
      })
    })
  })

  describe('failing soft', () => {
    it('logs and returns when the receipt cannot be written, and raises nothing', async () => {
      recordMock.mockResolvedValue({ ok: false, error: 'denied' })
      await expect(
        writeCallbackReceipt(CLIENT, input({ earlier: { ok: true, earlier: EARLIER } })),
      ).resolves.toBeUndefined()
      expect(loggedText()).toContain('instagram_callback_receipt_unrecorded')
      expect(replayedMock).not.toHaveBeenCalled()
    })

    it('logs and writes nothing when a verified request had no fingerprintable payload', async () => {
      await writeCallbackReceipt(CLIENT, input({ fingerprint: null }))
      expect(recordMock).not.toHaveBeenCalled()
      expect(loggedText()).toContain('instagram_callback_receipt_skipped')
    })
  })

  // Nothing from the payload beyond the account id, and never the
  // fingerprint: it is a database-side join key, and an alert carrying it
  // invites someone to treat it as a secret it is not.
  it('puts no fingerprint in the alert', async () => {
    await writeCallbackReceipt(CLIENT, input({ earlier: { ok: true, earlier: EARLIER } }))
    expect(JSON.stringify(replayedMock.mock.calls)).not.toContain(FINGERPRINT)
  })
})
