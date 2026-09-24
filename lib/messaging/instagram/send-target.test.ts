import { describe, expect, it } from 'vitest'

import { loadInstagramSendTarget, readInstagramAccessToken } from './send-target'
import { callsNamed, queryRecorder } from './testing/query-recorder'
import { failResolveToken, stubResolveToken } from './testing/token-stub'

const INPUT = { venueId: 'venue-1', guestId: 'guest-1' }

function recorder(venue: unknown, guest: unknown) {
  return queryRecorder({
    venues: [{ data: venue, error: null }],
    guests: [{ data: guest, error: null }],
  })
}

describe('loadInstagramSendTarget', () => {
  it("reads the venue's Instagram account and the guest's scoped ID, and never the messaging phone number", async () => {
    const { client, queries } = recorder({ instagram_account_id: '17841400000000001' }, { instagram_scoped_id: '1000000000000001' })
    const result = await loadInstagramSendTarget(client, INPUT, stubResolveToken('token'))
    expect(result).toEqual({
      ok: true,
      target: {
        accountId: '17841400000000001',
        recipientId: '1000000000000001',
        token: 'token',
        tokenSource: 'env',
      },
    })
    const venueQuery = queries.find((q) => q.table === 'venues')!
    const guestQuery = queries.find((q) => q.table === 'guests')!
    expect(callsNamed(venueQuery, 'select')).toEqual([['instagram_account_id']])
    expect(callsNamed(guestQuery, 'select')).toEqual([['instagram_scoped_id']])
    // Scoped to the venue, so one venue's send can never reach another's guest.
    expect(callsNamed(guestQuery, 'eq')).toEqual([
      ['id', 'guest-1'],
      ['venue_id', 'venue-1'],
    ])
    expect(JSON.stringify(queries)).not.toContain('messaging_phone_number')
  })

  it('works at a venue with no messaging number (an Instagram-only venue)', async () => {
    const { client } = recorder(
      { instagram_account_id: '17841400000000001', messaging_phone_number: null },
      { instagram_scoped_id: '1000000000000001' },
    )
    expect((await loadInstagramSendTarget(client, INPUT, stubResolveToken('token'))).ok).toBe(true)
  })

  it.each([
    [{ instagram_account_id: 'acct' }, { instagram_scoped_id: null }, 'guest_has_no_instagram_id'],
    [{ instagram_account_id: 'acct' }, null, 'guest_has_no_instagram_id'],
    [{ instagram_account_id: null }, { instagram_scoped_id: 'igsid' }, 'venue_has_no_instagram_account'],
    [{ instagram_account_id: '  ' }, { instagram_scoped_id: 'igsid' }, 'venue_has_no_instagram_account'],
  ])('refuses %j / %j as %s', async (venue, guest, problem) => {
    const { client } = recorder(venue, guest)
    expect(await loadInstagramSendTarget(client, INPUT, stubResolveToken('token'))).toEqual({ ok: false, problem })
  })

  it('refuses when the token is missing', async () => {
    const { client } = recorder({ instagram_account_id: 'acct' }, { instagram_scoped_id: 'igsid' })
    expect(await loadInstagramSendTarget(client, INPUT, stubResolveToken(null))).toEqual({ ok: false, problem: 'token_missing' })
  })

  // THE CALL SITE'S ONE ARGUMENT. Passing input.guestId here instead of
  // input.venueId resolved no credential, fell back to the shared env token
  // for EVERY venue, and passed all 2156 tests across 63 files — the whole
  // per-venue feature inert, green (found in code review). The stub records
  // its arguments so this can be asserted at all.
  it('asks the resolver about the VENUE, not the guest', async () => {
    const { client } = recorder({ instagram_account_id: 'acct' }, { instagram_scoped_id: 'igsid' })
    const resolve = stubResolveToken('token')
    await loadInstagramSendTarget(client, INPUT, resolve)
    expect(resolve).toHaveBeenCalledWith(client, INPUT.venueId)
    expect(resolve).not.toHaveBeenCalledWith(client, INPUT.guestId)
  })

  // TAC-516. The source is what proves a send used the venue's OWN credential
  // rather than silently riding the shared env fallback, which is how the Le
  // Mil's cutover is verified.
  it("carries the venue's own credential through as the token source", async () => {
    const { client } = recorder({ instagram_account_id: 'acct' }, { instagram_scoped_id: 'igsid' })
    const result = await loadInstagramSendTarget(client, INPUT, stubResolveToken('venue-token', 'venue'))
    expect(result).toEqual({
      ok: true,
      target: { accountId: 'acct', recipientId: 'igsid', token: 'venue-token', tokenSource: 'venue' },
    })
  })

  // Distinct from token_missing: that one waits for a venue to connect, this
  // one means a credential exists and INSTAGRAM_TOKEN_ENC_KEY needs looking
  // at. Collapsing them sends whoever is on call to the wrong place.
  it('reports an unreadable stored credential separately from a missing token', async () => {
    const { client } = recorder({ instagram_account_id: 'acct' }, { instagram_scoped_id: 'igsid' })
    expect(
      await loadInstagramSendTarget(client, INPUT, failResolveToken('could not decrypt the stored Instagram token')),
    ).toEqual({
      ok: false,
      problem: 'token_unreadable',
      error: 'could not decrypt the stored Instagram token',
    })
  })

  it('reports a failed lookup', async () => {
    const { client } = queryRecorder({
      venues: [{ data: null, error: { message: 'boom' } }],
      guests: [{ data: null, error: null }],
    })
    expect(await loadInstagramSendTarget(client, INPUT, stubResolveToken('token'))).toEqual({
      ok: false,
      problem: 'lookup_failed',
      error: 'boom',
    })
  })
})

describe('readInstagramAccessToken', () => {
  it('reads the token at call time and treats blank as missing', () => {
    expect(readInstagramAccessToken({ INSTAGRAM_ACCESS_TOKEN: ' abc ' } as unknown as NodeJS.ProcessEnv)).toBe('abc')
    expect(readInstagramAccessToken({ INSTAGRAM_ACCESS_TOKEN: '  ' } as unknown as NodeJS.ProcessEnv)).toBeNull()
    expect(readInstagramAccessToken({} as unknown as NodeJS.ProcessEnv)).toBeNull()
  })
})
