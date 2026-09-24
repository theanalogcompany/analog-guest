// TAC-516: what the data-deletion callback actually erases.
//
// The guest and message patches are pinned with toEqual, not toMatchObject.
// A partial match passes while a column silently stops being redacted, and
// the whole subject here is WHICH columns move — the same reason TAC-318
// pins its field set exactly.

import { describe, expect, it } from 'vitest'

import {
  REDACTED_MESSAGE_BODY,
  deleteInstagramVenueData,
  instagramScopedIdTombstone,
} from './delete-venue-data'
import { callsNamed, queryRecorder } from './testing/query-recorder'

const VENUE_ID = 'venue-1'
const ACCOUNT_ID = '17841479626987104'

function scripted(guestIds: string[]) {
  return queryRecorder({
    venues: [
      { data: { id: VENUE_ID }, error: null },
      { data: null, error: null }, // clearing instagram_account_id
    ],
    guests: [
      { data: guestIds.map((id) => ({ id })), error: null },
      ...guestIds.map(() => ({ data: null, error: null })),
    ],
    messages: [{ data: null, error: null }],
    instagram_credentials: [{ data: null, error: null }],
  })
}

describe('instagramScopedIdTombstone', () => {
  // The tombstone exists because migration 048's guests_must_have_identity
  // CHECK forbids nulling both phone_number and instagram_scoped_id. It has
  // to be unique per row, because (venue_id, instagram_scoped_id) is unique.
  it('is unique each time and carries nothing about the person', () => {
    const a = instagramScopedIdTombstone()
    const b = instagramScopedIdTombstone()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^deleted:[0-9a-f-]{36}$/)
  })
})

describe('deleteInstagramVenueData', () => {
  it('redacts every identifying column on the guest, and keeps the operational ones', async () => {
    const { client, queries } = scripted(['guest-1'])
    const result = await deleteInstagramVenueData(client, ACCOUNT_ID)
    expect(result).toMatchObject({ ok: true, venueId: VENUE_ID, guestsAffected: 1 })

    const guestUpdate = queries.filter((q) => q.table === 'guests')[1]
    const [[patch]] = callsNamed(guestUpdate, 'update') as [[Record<string, unknown>]]

    // Pinned exactly. A column added to guests that carries identity has to
    // be decided about here rather than quietly surviving a deletion.
    expect(Object.keys(patch).sort()).toEqual([
      'context',
      'distance_to_venue_miles',
      'email',
      'first_name',
      'home_postal_code',
      'instagram_name',
      'instagram_profile_attempted_at',
      'instagram_profile_fetched_at',
      'instagram_scoped_id',
      'instagram_username',
      'last_name',
      'phone_number',
    ])
    expect(patch.phone_number).toBeNull()
    expect(patch.first_name).toBeNull()
    expect(patch.instagram_username).toBeNull()
    expect(patch.context).toEqual({})
  })

  // THE CONSTRAINT THE PLAN MISSED. Nulling the scoped id as well as the
  // phone violates guests_must_have_identity, and every deletion request
  // would fail on the one callback Meta tests.
  it('tombstones the scoped id rather than nulling it, so the identity CHECK still holds', async () => {
    const { client, queries } = scripted(['guest-1'])
    await deleteInstagramVenueData(client, ACCOUNT_ID)

    const guestUpdate = queries.filter((q) => q.table === 'guests')[1]
    const [[patch]] = callsNamed(guestUpdate, 'update') as [[Record<string, unknown>]]
    expect(patch.phone_number).toBeNull()
    expect(patch.instagram_scoped_id).not.toBeNull()
    expect(String(patch.instagram_scoped_id)).toMatch(/^deleted:/)
  })

  // Each guest needs its OWN tombstone: a shared value collides on
  // (venue_id, instagram_scoped_id).
  it('gives every guest a different tombstone', async () => {
    const { client, queries } = scripted(['guest-1', 'guest-2'])
    await deleteInstagramVenueData(client, ACCOUNT_ID)

    const updates = queries.filter((q) => q.table === 'guests').slice(1)
    const tombstones = updates.map(
      (q) => (callsNamed(q, 'update')[0][0] as Record<string, unknown>).instagram_scoped_id,
    )
    expect(tombstones).toHaveLength(2)
    expect(new Set(tombstones).size).toBe(2)
  })

  it('redacts the message body, media, review and the mid, keeping the row shell', async () => {
    const { client, queries } = scripted(['guest-1'])
    await deleteInstagramVenueData(client, ACCOUNT_ID)

    const messageUpdate = queries.find((q) => q.table === 'messages')!
    const [[patch]] = callsNamed(messageUpdate, 'update') as [[Record<string, unknown>]]
    expect(patch).toEqual({
      body: REDACTED_MESSAGE_BODY,
      media_urls: [],
      response_review: null,
      replaced_draft_body: null,
      provider_message_id: null,
    })
    // Scoped to this venue AND these guests: one venue's deletion must never
    // reach another's rows.
    expect(callsNamed(messageUpdate, 'eq')).toEqual([['venue_id', VENUE_ID]])
    expect(callsNamed(messageUpdate, 'in')).toEqual([['guest_id', ['guest-1']]])
  })

  it('hard-deletes the credential and frees the account id', async () => {
    const { client, queries } = scripted(['guest-1'])
    await deleteInstagramVenueData(client, ACCOUNT_ID)

    const credential = queries.find((q) => q.table === 'instagram_credentials')!
    expect(callsNamed(credential, 'delete')).toHaveLength(1)
    expect(callsNamed(credential, 'eq')).toEqual([['venue_id', VENUE_ID]])

    const venueUpdate = queries.filter((q) => q.table === 'venues')[1]
    const [[patch]] = callsNamed(venueUpdate, 'update') as [[Record<string, unknown>]]
    expect(patch).toEqual({ instagram_account_id: null })
  })

  // Messages before guests: if the guest redaction succeeded and the message
  // one failed, the bodies would survive with no identity left to find them.
  it('redacts messages before guests', async () => {
    const { client, queries } = scripted(['guest-1'])
    await deleteInstagramVenueData(client, ACCOUNT_ID)

    const tables = queries.map((q) => q.table)
    expect(tables.indexOf('messages')).toBeLessThan(tables.lastIndexOf('guests'))
  })

  it('scopes the guest scan to this venue and to Instagram guests only', async () => {
    const { client, queries } = scripted(['guest-1'])
    await deleteInstagramVenueData(client, ACCOUNT_ID)

    const scan = queries.filter((q) => q.table === 'guests')[0]
    expect(callsNamed(scan, 'eq')).toEqual([['venue_id', VENUE_ID]])
    expect(callsNamed(scan, 'not')).toEqual([['instagram_scoped_id', 'is', null]])
  })

  // Meta can send a request for an account we never finished connecting.
  // Zero affected is a legitimate answer, not a failure.
  it('answers cleanly for an account no venue owns, touching nothing', async () => {
    const { client, queries } = queryRecorder({ venues: [{ data: null, error: null }] })
    const result = await deleteInstagramVenueData(client, 'unknown-account')
    expect(result).toMatchObject({ ok: true, venueId: null, guestsAffected: 0 })
    expect(queries).toHaveLength(1)
  })

  it('answers cleanly for a venue with no Instagram guests', async () => {
    const { client } = scripted([])
    const result = await deleteInstagramVenueData(client, ACCOUNT_ID)
    expect(result).toMatchObject({ ok: true, guestsAffected: 0 })
  })

  it('always returns a confirmation code, including on failure', async () => {
    const { client } = queryRecorder({ venues: [{ data: null, error: { message: 'timeout' } }] })
    const result = await deleteInstagramVenueData(client, ACCOUNT_ID)
    expect(result.ok).toBe(false)
    expect(result.confirmationCode).toMatch(/^[0-9a-f]{32}$/)
  })

  it('stops and reports when the message redaction fails, rather than claiming success', async () => {
    const { client } = queryRecorder({
      venues: [{ data: { id: VENUE_ID }, error: null }],
      guests: [{ data: [{ id: 'guest-1' }], error: null }],
      messages: [{ data: null, error: { message: 'write conflict' } }],
    })
    const result = await deleteInstagramVenueData(client, ACCOUNT_ID)
    expect(result).toMatchObject({ ok: false, error: 'write conflict' })
  })
})
