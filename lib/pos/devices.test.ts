import { describe, expect, it } from 'vitest'

import { buildDeviceEvents, deriveTapToken, hashDeviceToken, verifyDeviceToken } from './devices'

describe('device token hashing', () => {
  it('verifies a matching token and rejects a wrong one', () => {
    const hash = hashDeviceToken('device-token-abc')
    expect(verifyDeviceToken('device-token-abc', hash)).toBe(true)
    expect(verifyDeviceToken('wrong', hash)).toBe(false)
  })
})

describe('deriveTapToken', () => {
  it('is deterministic, prefixed, and unique per transaction', () => {
    const a = deriveTapToken('txn_1', 'secret')
    expect(a).toBe(deriveTapToken('txn_1', 'secret'))
    expect(a).not.toBe(deriveTapToken('txn_2', 'secret'))
    expect(a.startsWith('tt_')).toBe(true)
  })
})

describe('buildDeviceEvents', () => {
  it('maps matched transactions to returning and unmatched to new', () => {
    const events = buildDeviceEvents(
      [
        { id: 't1', occurred_at: '2026-06-15T10:00:00Z', guest_id: 'g1' },
        { id: 't2', occurred_at: '2026-06-15T10:01:00Z', guest_id: null },
      ],
      (id) => `tok_${id}`,
    )
    expect(events).toEqual([
      { type: 'transaction', txId: 't1', at: '2026-06-15T10:00:00Z', guest: 'returning', tapToken: 'tok_t1', hasNotes: true },
      { type: 'transaction', txId: 't2', at: '2026-06-15T10:01:00Z', guest: 'new', tapToken: 'tok_t2', hasNotes: true },
    ])
  })

  it('returns [] for no rows', () => {
    expect(buildDeviceEvents([], (id) => id)).toEqual([])
  })
})
