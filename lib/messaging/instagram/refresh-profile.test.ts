// The profile refresh, run against the in-memory store (with guests updatable)
// and a fetch the test controls. The write payloads are pinned whole with
// toEqual: which columns a refresh touches is the point, and a partial match
// would pass a refresh that also wrote first_name.

import { formatWithOptions } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INSTAGRAM_GRAPH_BASE_URL } from './fetch-profile'
import type { InstagramEventOutcome } from './handle-events'
import {
  INSTAGRAM_PROFILE_RETRY_AFTER_MS,
  INSTAGRAM_PROFILE_STALE_AFTER_MS,
  isProfileRefreshDue,
  profileRefreshTargetFor,
  refreshInstagramProfile,
  type RefreshDeps,
} from './refresh-profile'
import { createInstagramDbFake, type FakeRow } from './testing/db-fake'

const NOW = '2026-09-18T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const ago = (ms: number): string => new Date(NOW_MS - ms).toISOString()
const HOUR = 60 * 60 * 1000

const VENUE_ID = 'venue-1'
const GUEST_ID = 'guest-1'
const ACCOUNT_ID = '17841400000000001'
const OTHER_ACCOUNT_ID = '17841499999999999'
const IGSID = '1000000000000001'
const TOKEN = 'IGAAtesttoken-value'
const TARGET = { guestId: GUEST_ID, venueId: VENUE_ID }

const VENUE: FakeRow = { id: VENUE_ID, instagram_account_id: ACCOUNT_ID }

function guestRow(overrides: Record<string, unknown> = {}): FakeRow {
  return {
    id: GUEST_ID,
    venue_id: VENUE_ID,
    phone_number: null,
    first_name: null,
    last_name: null,
    instagram_scoped_id: IGSID,
    instagram_username: null,
    instagram_name: null,
    instagram_profile_fetched_at: null,
    instagram_profile_attempted_at: null,
    ...overrides,
  }
}

type GraphReply = { status: number; body: unknown } | { throws: unknown }

/**
 * A fetch that answers /me and the profile endpoint separately. Defaults: the
 * token is this venue's account, and the profile is Maya's.
 */
function graph(replies: { me?: GraphReply; profile?: GraphReply } = {}) {
  const urls: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(url)
    const isMe = url.startsWith(`${INSTAGRAM_GRAPH_BASE_URL}/me?`)
    const reply =
      (isMe ? replies.me : replies.profile) ??
      (isMe
        ? { status: 200, body: { user_id: ACCOUNT_ID } }
        : { status: 200, body: { username: 'maya.oakland', name: 'Maya' } })
    if ('throws' in reply) throw reply.throws
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  })
  return {
    fetchImpl,
    urls,
    profileCalls: () => urls.filter((u) => !u.startsWith(`${INSTAGRAM_GRAPH_BASE_URL}/me?`)).length,
    meCalls: () => urls.filter((u) => u.startsWith(`${INSTAGRAM_GRAPH_BASE_URL}/me?`)).length,
  }
}

/** Pass `{}` for an unset token: a defaulted parameter would read undefined as TOKEN. */
function deps(fetchImpl: RefreshDeps['fetch'], env: { token?: string } = { token: TOKEN }): RefreshDeps {
  return { fetch: fetchImpl, now: () => new Date(NOW), readToken: () => env.token }
}

// A Graph error as Meta formats it. Its message names the guest's scoped ID.
const refusal = {
  status: 400,
  body: {
    error: {
      message: `Unsupported get request. Object with ID '${IGSID}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      type: 'IGApiException',
      code: 100,
      error_subcode: 33,
      fbtrace_id: 'AbCdEf123',
    },
  },
}
const expiredToken = {
  status: 400,
  body: { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'XyZ' } },
}

let logged: unknown[][] = []

/** Everything logged, rendered the way console renders it, with no limits (TAC-458). */
function loggedText(): string {
  return logged
    .map((args) =>
      formatWithOptions({ depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, breakLength: Infinity }, ...args),
    )
    .join('\n')
}

function entry(event: string): Record<string, unknown> | undefined {
  for (const args of logged) {
    const payload = args[1] as Record<string, unknown> | undefined
    if (payload?.event === event) return payload
  }
  return undefined
}

const logLevel = { log: [] as string[], warn: [] as string[], error: [] as string[] }

beforeEach(() => {
  logged = []
  logLevel.log = []
  logLevel.warn = []
  logLevel.error = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args)
      const event = (args[1] as Record<string, unknown> | undefined)?.event
      if (typeof event === 'string') logLevel[level].push(event)
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isProfileRefreshDue', () => {
  const now = new Date(NOW)
  it.each<[string, string | null, string | null, boolean]>([
    ['never fetched or tried: due', null, null, true],
    ['fetched 25 hours ago: due', ago(25 * HOUR), ago(25 * HOUR), true],
    ['fetched exactly 24 hours ago: due', ago(INSTAGRAM_PROFILE_STALE_AFTER_MS), ago(INSTAGRAM_PROFILE_STALE_AFTER_MS), true],
    ['fetched 23 hours ago: not due', ago(23 * HOUR), ago(23 * HOUR), false],
    ['never fetched, a failed try 30 minutes ago: not due', null, ago(30 * 60 * 1000), false],
    ['never fetched, a failed try 61 minutes ago: due', null, ago(61 * 60 * 1000), true],
    ['never fetched, a failed try exactly an hour ago: due', null, ago(INSTAGRAM_PROFILE_RETRY_AFTER_MS), true],
    ['fetched 2 days ago, a failed try 30 minutes ago: not due', ago(48 * HOUR), ago(30 * 60 * 1000), false],
    ['fetched 2 days ago, a failed try 2 hours ago: due', ago(48 * HOUR), ago(2 * HOUR), true],
    ['an unreadable stored time: due', 'not a time', 'not a time', true],
  ])('%s', (_label, fetchedAt, attemptedAt, due) => {
    expect(isProfileRefreshDue({ fetchedAt, attemptedAt }, now)).toBe(due)
  })
})

describe('profileRefreshTargetFor', () => {
  const persisted = (kind: 'message' | 'postback' | 'echo'): InstagramEventOutcome => ({
    status: 'persisted',
    kind,
    venueId: VENUE_ID,
    guestId: GUEST_ID,
    messageId: 'msg-1',
    guestCreated: true,
    hasReferral: false,
    hasProviderSentAt: true,
  })

  it.each(['message', 'postback'] as const)('refreshes the guest behind a saved %s', (kind) => {
    expect(profileRefreshTargetFor(persisted(kind))).toEqual(TARGET)
  })

  it.each<[string, InstagramEventOutcome]>([
    ['a saved echo (the venue\'s own message)', persisted('echo')],
    ['a duplicate', { status: 'duplicate', kind: 'message', venueId: VENUE_ID, messageId: 'msg-1' }],
    ['a read receipt', { status: 'read', venueId: VENUE_ID, guestId: GUEST_ID, messageId: 'msg-1' }],
    ['a skipped event', { status: 'skipped', kind: 'message', reason: 'venue_not_found' }],
    ['a failed save', { status: 'failed', kind: 'message', stage: 'message_insert', error: 'x', code: null }],
    ['an unhandled event', { status: 'unhandled', reason: 'standby', fields: [] }],
  ])('refreshes nobody for %s', (_label, outcome) => {
    expect(profileRefreshTargetFor(outcome)).toBeNull()
  })
})

describe('refreshInstagramProfile: a successful fetch', () => {
  it('stores the handle, the name and the fetch time for a new guest, and nothing else', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    const g = graph()
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(g.fetchImpl))

    expect(outcome).toEqual({ status: 'refreshed', hadProfile: false, usernameChanged: false, hasName: true })
    expect(db.updates('guests')).toEqual([
      {
        patch: { instagram_profile_attempted_at: NOW },
        filters: [
          ['id', 'eq', GUEST_ID],
          ['venue_id', 'eq', VENUE_ID],
          ['instagram_profile_attempted_at', 'is', null],
        ],
      },
      {
        // Never first_name or last_name: the display name is not a name the
        // guest gave the venue (ruled 2026-09-18).
        patch: { instagram_username: 'maya.oakland', instagram_name: 'Maya', instagram_profile_fetched_at: NOW },
        filters: [
          ['id', 'eq', GUEST_ID],
          ['venue_id', 'eq', VENUE_ID],
        ],
      },
    ])
    expect(db.tables.guests[0]).toMatchObject({ first_name: null, last_name: null, instagram_username: 'maya.oakland' })
    expect(g.meCalls()).toBe(1)
    expect(g.profileCalls()).toBe(1)
    expect(entry('instagram_profile_refreshed')).toEqual({
      event: 'instagram_profile_refreshed',
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      hadProfile: false,
      usernameChanged: false,
      hasName: true,
    })
  })

  it('stores a guest with no display name as a null name', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    await refreshInstagramProfile(db.client, TARGET, deps(graph({ profile: { status: 200, body: { username: 'maya' } } }).fetchImpl))
    expect(db.tables.guests[0]).toMatchObject({ instagram_username: 'maya', instagram_name: null })
  })
})

describe('refreshInstagramProfile: a stale profile', () => {
  it('refetches a profile over a day old and overwrites the old handle', async () => {
    const stale = guestRow({
      instagram_username: 'maya.old',
      instagram_name: 'Maya O',
      instagram_profile_fetched_at: ago(25 * HOUR),
      instagram_profile_attempted_at: ago(25 * HOUR),
    })
    const db = createInstagramDbFake({ venues: [VENUE], guests: [stale] }, { updatable: ['guests'] })
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(graph().fetchImpl))

    expect(outcome).toEqual({ status: 'refreshed', hadProfile: true, usernameChanged: true, hasName: true })
    expect(db.tables.guests[0]).toMatchObject({
      instagram_username: 'maya.oakland',
      instagram_name: 'Maya',
      instagram_profile_fetched_at: NOW,
      instagram_profile_attempted_at: NOW,
    })
    // The claim holds on the attempt time it read, so a racing refresh loses.
    expect(db.updates('guests')[0]?.filters).toContainEqual(['instagram_profile_attempted_at', 'eq', ago(25 * HOUR)])
  })

  it('leaves a profile under a day old alone: no Graph call and no write', async () => {
    const fresh = guestRow({
      instagram_username: 'maya.oakland',
      instagram_profile_fetched_at: ago(23 * HOUR),
      instagram_profile_attempted_at: ago(23 * HOUR),
    })
    const db = createInstagramDbFake({ venues: [VENUE], guests: [fresh] }, { updatable: ['guests'] })
    const g = graph()
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(g.fetchImpl))

    expect(outcome).toEqual({ status: 'not_due' })
    expect(g.fetchImpl).not.toHaveBeenCalled()
    expect(db.updates('guests')).toEqual([])
    expect(logged).toEqual([])
  })

  it('does not retry a failed fetch within the hour, and does after it', async () => {
    const recent = guestRow({ instagram_profile_attempted_at: ago(30 * 60 * 1000) })
    const later = guestRow({ instagram_profile_attempted_at: ago(61 * 60 * 1000) })
    const g = graph()

    const db1 = createInstagramDbFake({ venues: [VENUE], guests: [recent] }, { updatable: ['guests'] })
    expect(await refreshInstagramProfile(db1.client, TARGET, deps(g.fetchImpl))).toEqual({ status: 'not_due' })
    expect(g.fetchImpl).not.toHaveBeenCalled()

    const db2 = createInstagramDbFake({ venues: [VENUE], guests: [later] }, { updatable: ['guests'] })
    expect(await refreshInstagramProfile(db2.client, TARGET, deps(g.fetchImpl))).toMatchObject({ status: 'refreshed' })
  })
})

describe('refreshInstagramProfile: a failed fetch leaves a usable guest', () => {
  const KEPT = guestRow({
    instagram_username: 'maya.old',
    instagram_name: 'Maya O',
    instagram_profile_fetched_at: ago(48 * HOUR),
    instagram_profile_attempted_at: ago(48 * HOUR),
  })

  it.each<[string, GraphReply]>([
    ['a privacy refusal or unknown object', refusal],
    ['a timeout', { throws: new DOMException('The operation was aborted due to timeout', 'TimeoutError') }],
    ['a network failure', { throws: new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }) }],
    ['a malformed 200', { status: 200, body: { name: 'no username' } }],
  ])('on %s: keeps the handle, records only the attempt, logs and resolves', async (_label, profile) => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [{ ...KEPT }] }, { updatable: ['guests'] })
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(graph({ profile }).fetchImpl))

    expect(outcome).toMatchObject({ status: 'fetch_failed', step: 'profile' })
    expect(db.updates('guests').map((u) => u.patch)).toEqual([{ instagram_profile_attempted_at: NOW }])
    expect(db.tables.guests[0]).toEqual({ ...KEPT, instagram_profile_attempted_at: NOW })
    expect(logLevel.warn).toEqual(['instagram_profile_fetch_failed'])
    expect(logLevel.error).toEqual([])
  })

  it('logs Meta\'s codes and never Meta\'s message, which carries the scoped ID', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    await refreshInstagramProfile(db.client, TARGET, deps(graph({ profile: refusal }).fetchImpl))

    expect(entry('instagram_profile_fetch_failed')).toEqual({
      event: 'instagram_profile_fetch_failed',
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      step: 'profile',
      reason: 'graph_error',
      httpStatus: 400,
      graphCode: 100,
      graphSubcode: 33,
      graphType: 'IGApiException',
      fbtraceId: 'AbCdEf123',
    })
    expect(db.tables.guests[0]).toMatchObject({ instagram_username: null, instagram_name: null, instagram_profile_fetched_at: null })
  })

  it('keeps a guest usable when the database write fails, and logs no row values', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    const g = graph()
    // The profile arrives between the claim and the write; the database fails
    // on the write that follows it.
    const fetchImpl: RefreshDeps['fetch'] = async (url, init) => {
      const response = await g.fetchImpl(url)
      if (!url.startsWith(`${INSTAGRAM_GRAPH_BASE_URL}/me?`)) {
        db.failNext('guests', 'update', { code: '23514', message: 'violates check constraint' })
      }
      void init
      return response
    }
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(fetchImpl))

    expect(outcome).toEqual({ status: 'store_failed', stage: 'write', error: 'violates check constraint', code: '23514' })
    expect(db.tables.guests[0]).toMatchObject({ instagram_username: null, instagram_profile_attempted_at: NOW })
    expect(logLevel.warn).toEqual(['instagram_profile_store_failed'])
    expect(loggedText()).not.toContain('maya.oakland')
  })

  it('resolves, never rejects, when something unexpected throws', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    vi.spyOn(db.client, 'from').mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(refreshInstagramProfile(db.client, TARGET, deps(graph().fetchImpl))).resolves.toEqual({
      status: 'unexpected',
      error: 'boom',
    })
    expect(logLevel.error).toEqual(['instagram_profile_unexpected_error'])
  })
})

describe('refreshInstagramProfile: the claim', () => {
  it('stops without a Graph profile call when another refresh claims the guest first', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    db.beforeNextUpdate('guests', () => {
      const row = db.tables.guests[0]
      if (row) row.instagram_profile_attempted_at = ago(1000)
    })
    const g = graph()
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(g.fetchImpl))

    expect(outcome).toEqual({ status: 'claimed_elsewhere' })
    expect(g.profileCalls()).toBe(0)
    expect(db.tables.guests[0]).toMatchObject({ instagram_username: null, instagram_profile_attempted_at: ago(1000) })
    expect(logged).toEqual([])
  })
})

// The three configuration failures, each under its own event at error level,
// so none is mistaken for another or for a guest's privacy settings. None of
// them claims, so each is logged again on the guest's next message until it is
// fixed.
describe('refreshInstagramProfile: configuration failures are told apart', () => {
  it.each<[string, { token?: string }]>([
    ['unset', {}],
    ['empty', { token: '' }],
  ])('logs an %s token and claims nothing, so the first message after it is set still fetches', async (_label, env) => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    const g = graph()
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(g.fetchImpl, env))

    expect(outcome).toEqual({ status: 'token_missing' })
    expect(g.fetchImpl).not.toHaveBeenCalled()
    expect(db.updates('guests')).toEqual([])
    expect(logLevel.error).toEqual(['instagram_profile_token_missing'])
  })

  it('logs a token for another account as wrong_account, and never asks for the profile', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    const g = graph({ me: { status: 200, body: { user_id: OTHER_ACCOUNT_ID } } })
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(g.fetchImpl))

    expect(outcome).toEqual({ status: 'wrong_account', venueAccountMissing: false })
    expect(g.profileCalls()).toBe(0)
    expect(db.updates('guests')).toEqual([])
    expect(logLevel.error).toEqual(['instagram_profile_wrong_account'])
    expect(entry('instagram_profile_wrong_account')).toEqual({
      event: 'instagram_profile_wrong_account',
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      venueAccountMissing: false,
    })
  })

  it('treats a venue with no account mapped as the wrong account', async () => {
    const db = createInstagramDbFake(
      { venues: [{ id: VENUE_ID, instagram_account_id: null }], guests: [guestRow()] },
      { updatable: ['guests'] },
    )
    expect(await refreshInstagramProfile(db.client, TARGET, deps(graph().fetchImpl))).toEqual({
      status: 'wrong_account',
      venueAccountMissing: true,
    })
  })

  it('logs an expired token found by the account check as token_rejected, and claims nothing', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    const g = graph({ me: expiredToken })
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(g.fetchImpl))

    expect(outcome).toMatchObject({ status: 'token_rejected', step: 'token_account' })
    expect(g.profileCalls()).toBe(0)
    expect(db.updates('guests')).toEqual([])
    expect(logLevel.error).toEqual(['instagram_profile_token_rejected'])
    expect(entry('instagram_profile_token_rejected')).toMatchObject({ graphCode: 190, graphSubcode: 463 })
  })

  it('logs a token that expires between the two calls as token_rejected too', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    const outcome = await refreshInstagramProfile(db.client, TARGET, deps(graph({ profile: expiredToken }).fetchImpl))

    expect(outcome).toMatchObject({ status: 'token_rejected', step: 'profile' })
    expect(logLevel.error).toEqual(['instagram_profile_token_rejected'])
  })

  it('logs a failed account check that is not a token problem as a fetch failure, not a config error', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [guestRow()] }, { updatable: ['guests'] })
    const outcome = await refreshInstagramProfile(
      db.client,
      TARGET,
      deps(graph({ me: { throws: new DOMException('timeout', 'TimeoutError') } }).fetchImpl),
    )

    expect(outcome).toEqual({ status: 'fetch_failed', step: 'token_account', failure: { reason: 'timeout' } })
    expect(logLevel.warn).toEqual(['instagram_profile_fetch_failed'])
    expect(logLevel.error).toEqual([])
  })
})

describe('refreshInstagramProfile: logs', () => {
  it('never writes the scoped ID, the handle, the name, the token, an account ID or Meta\'s message', async () => {
    const scenarios: Array<{ me?: GraphReply; profile?: GraphReply; env?: { token?: string } }> = [
      {},
      { profile: refusal },
      { me: expiredToken },
      { me: { status: 200, body: { user_id: OTHER_ACCOUNT_ID } } },
      { env: {} },
    ]
    for (const scenario of scenarios) {
      const db = createInstagramDbFake(
        { venues: [VENUE], guests: [guestRow({ instagram_username: 'maya.old', instagram_name: 'Maya O', instagram_profile_fetched_at: ago(48 * HOUR) })] },
        { updatable: ['guests'] },
      )
      await refreshInstagramProfile(db.client, TARGET, deps(graph(scenario).fetchImpl, scenario.env))
    }

    expect(logged.length).toBeGreaterThanOrEqual(scenarios.length)
    const text = loggedText()
    for (const secret of [IGSID, 'maya.oakland', 'maya.old', 'Maya O', TOKEN, ACCOUNT_ID, OTHER_ACCOUNT_ID, 'Unsupported get request', 'Session has expired']) {
      expect(text).not.toContain(secret)
    }
  })
})
