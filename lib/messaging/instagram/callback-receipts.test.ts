// TAC-516 follow-up: the callback replay trail.
//
// The store's correctness is mostly in the FILTERS it sends, so these assert
// on the recorded query-builder calls rather than on a mock's opinion of them
// (the TAC-377 / TAC-385 trap CLAUDE.md records).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CALLBACK_KINDS,
  CALLBACK_OUTCOMES,
  findEarlierDelivery,
  isConsequentialRepeat,
  recordCallbackReceipt,
} from './callback-receipts'
import { callsNamed, queryRecorder } from './testing/query-recorder'

const FINGERPRINT = 'a'.repeat(64)
const ACCOUNT = '17841479626987104'
const VENUE = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-09-25T10:00:00.000Z')

const MIGRATION = readFileSync(
  join(process.cwd(), 'db/migrations/062_instagram_callback_receipts.sql'),
  'utf8',
)

describe('the vocabulary is bound to migration 062', () => {
  // SQL cannot import a TS constant, so the CHECK and the union can drift
  // silently: a value added to one is accepted by the type system and refused
  // by Postgres at 2am on a callback Meta disables after repeated failures.
  it.each(CALLBACK_KINDS)('migration 062 permits the callback kind %s', (kind) => {
    expect(MIGRATION).toContain(`'${kind}'`)
  })

  it.each(CALLBACK_OUTCOMES)('migration 062 permits the outcome %s', (outcome) => {
    expect(MIGRATION).toContain(`'${outcome}'`)
  })

  // The reverse direction, which the per-value checks above cannot see: a
  // value added to the CHECK and not to the union is a value nothing can
  // write, and one removed from the CHECK is a value that now fails.
  it('permits no callback kind or outcome the TypeScript unions do not carry', () => {
    const kinds = MIGRATION.match(/callback in \(([^)]*)\)/)![1]
    const outcomes = MIGRATION.match(/outcome in \(([^)]*)\)/)![1]
    const literals = (block: string) => block.match(/'([a-z_]+)'/g)!.map((v) => v.replaceAll("'", ''))
    expect(literals(kinds).sort()).toEqual([...CALLBACK_KINDS].sort())
    expect(literals(outcomes).sort()).toEqual([...CALLBACK_OUTCOMES].sort())
  })
})

describe('findEarlierDelivery', () => {
  it('asks for the newest row with this fingerprint, and nothing else', async () => {
    const { client, queries } = queryRecorder({
      instagram_callback_receipts: [{ data: null, error: null }],
    })
    await findEarlierDelivery(client, FINGERPRINT)
    const q = queries[0]
    expect(callsNamed(q, 'eq')).toEqual([['signed_request_fingerprint', FINGERPRINT]])
    // Newest first: an older receipt is not the one a repeat repeats.
    expect(callsNamed(q, 'order')).toEqual([['received_at', { ascending: false }]])
    expect(callsNamed(q, 'limit')).toEqual([[1]])
  })

  it('reports no earlier delivery as null rather than as a failure', async () => {
    const { client } = queryRecorder({ instagram_callback_receipts: [{ data: null, error: null }] })
    expect(await findEarlierDelivery(client, FINGERPRINT)).toEqual({ ok: true, earlier: null })
  })

  it('carries the earlier receipt back', async () => {
    const { client } = queryRecorder({
      instagram_callback_receipts: [
        {
          data: { id: 'receipt-1', received_at: '2026-09-25T09:00:00.000Z', outcome: 'applied' },
          error: null,
        },
      ],
    })
    expect(await findEarlierDelivery(client, FINGERPRINT)).toEqual({
      ok: true,
      earlier: {
        receiptId: 'receipt-1',
        receivedAt: new Date('2026-09-25T09:00:00.000Z'),
        outcome: 'applied',
      },
    })
  })

  // A FAILED READ IS NOT "NO EARLIER DELIVERY". Collapsing the two would
  // record a replay as a first delivery, which is the invisibility this whole
  // table exists to remove.
  it('reports a failed read as a failure, never as no earlier delivery', async () => {
    const { client } = queryRecorder({
      instagram_callback_receipts: [{ data: null, error: { message: 'timeout' } }],
    })
    expect(await findEarlierDelivery(client, FINGERPRINT)).toEqual({ ok: false, error: 'timeout' })
  })
})

describe('recordCallbackReceipt', () => {
  const base = {
    callback: 'data_deletion' as const,
    instagramAccountId: ACCOUNT,
    fingerprint: FINGERPRINT,
    payloadIssuedAt: new Date('2026-09-25T09:59:00.000Z'),
    venueId: VENUE,
    outcome: 'applied' as const,
    repeatOfReceiptId: null,
    repeatChecked: true,
    rowsAffected: 3,
    confirmationCode: 'code-1',
    now: NOW,
  }

  it('writes the row Meta gave us, with the repeat link and what it touched', async () => {
    const { client, queries } = queryRecorder({
      instagram_callback_receipts: [{ data: { id: 'receipt-2' }, error: null }],
    })
    const result = await recordCallbackReceipt(client, { ...base, repeatOfReceiptId: 'receipt-1' })
    expect(result).toEqual({ ok: true, receiptId: 'receipt-2' })
    expect(callsNamed(queries[0], 'insert')).toEqual([
      [
        {
          callback: 'data_deletion',
          instagram_account_id: ACCOUNT,
          signed_request_fingerprint: FINGERPRINT,
          payload_issued_at: '2026-09-25T09:59:00.000Z',
          received_at: NOW.toISOString(),
          venue_id: VENUE,
          outcome: 'applied',
          repeat_of_receipt_id: 'receipt-1',
          repeat_checked: true,
          rows_affected: 3,
          confirmation_code: 'code-1',
        },
      ],
    ])
  })

  it('carries a missing issued_at through as null rather than inventing a time', async () => {
    const { client, queries } = queryRecorder({
      instagram_callback_receipts: [{ data: { id: 'r' }, error: null }],
    })
    await recordCallbackReceipt(client, { ...base, payloadIssuedAt: null })
    const [[row]] = callsNamed(queries[0], 'insert') as [[Record<string, unknown>]]
    expect(row.payload_issued_at).toBeNull()
  })

  // A first delivery and a failed repeat check both carry a null
  // repeat_of_receipt_id, so this column is the only thing separating them in
  // the row. A query counting first deliveries has to exclude these.
  it('records an unchecked repeat status as unchecked, not as a first delivery', async () => {
    const { client, queries } = queryRecorder({
      instagram_callback_receipts: [{ data: { id: 'r' }, error: null }],
    })
    await recordCallbackReceipt(client, { ...base, repeatChecked: false })
    const [[row]] = callsNamed(queries[0], 'insert') as [[Record<string, unknown>]]
    expect(row.repeat_checked).toBe(false)
    expect(row.repeat_of_receipt_id).toBeNull()
  })

  it('reports a failed write rather than throwing into the callback', async () => {
    const { client } = queryRecorder({
      instagram_callback_receipts: [{ data: null, error: { message: 'denied' } }],
    })
    expect(await recordCallbackReceipt(client, base)).toEqual({ ok: false, error: 'denied' })
  })
})

describe('isConsequentialRepeat', () => {
  // The alert exists for exactly one case, and every other case is noise that
  // would train whoever is on call to ignore it.
  it('is true only for a deletion replay that actually redacted rows', () => {
    expect(
      isConsequentialRepeat({ callback: 'data_deletion', isRepeat: true, rowsAffected: 2 }),
    ).toBe(true)
  })

  it.each([
    ['a first delivery', { callback: 'data_deletion' as const, isRepeat: false, rowsAffected: 5 }],
    ['a repeated deauthorize', { callback: 'deauthorize' as const, isRepeat: true, rowsAffected: null }],
    ['a deletion replay that found nothing left', { callback: 'data_deletion' as const, isRepeat: true, rowsAffected: 0 }],
    ['a deletion replay with no count at all', { callback: 'data_deletion' as const, isRepeat: true, rowsAffected: null }],
  ])('is false for %s', (_label, input) => {
    expect(isConsequentialRepeat(input)).toBe(false)
  })
})
