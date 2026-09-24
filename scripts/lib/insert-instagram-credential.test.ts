import { describe, expect, it } from 'vitest'

import { decideAccountClaim, describeGraphFailure, parseInsertArgs } from './insert-instagram-credential'

const TARGET = 'venue-1'
const OTHER = 'venue-2'
const ACCOUNT = '17841479626987104'

describe('parseInsertArgs', () => {
  it('requires a venue', () => {
    expect(parseInsertArgs([])).toEqual({ ok: false, error: '--venue is required' })
  })

  it('reads the flags it supports', () => {
    const result = parseInsertArgs(['--venue', 'le-mils-coffee', '--confirm', '--operator', 'op-1'])
    expect(result).toEqual({
      ok: true,
      args: {
        venueSlug: 'le-mils-coffee',
        confirm: true,
        dryRun: false,
        expiresAtOverride: null,
        operatorId: 'op-1',
      },
    })
  })

  // --confirm is the gate on the one write, so it must never be something a
  // caller gets by accident: a bare `--venue --confirm` would silently read
  // "--confirm" as the slug under a naive parser and then look unconfirmed.
  it('refuses a flag where a value belongs rather than swallowing it', () => {
    expect(parseInsertArgs(['--venue', '--confirm'])).toEqual({
      ok: false,
      error: '--venue needs a slug',
    })
  })

  it('refuses an unreadable --expires-at instead of storing an Invalid Date', () => {
    const result = parseInsertArgs(['--venue', 'v', '--expires-at', 'next tuesday'])
    expect(result).toEqual({ ok: false, error: '--expires-at is not a date I can read: next tuesday' })
  })

  it('parses a real --expires-at', () => {
    const result = parseInsertArgs(['--venue', 'v', '--expires-at', '2026-11-21T00:00:00.000Z'])
    expect(result.ok && result.args.expiresAtOverride?.toISOString()).toBe('2026-11-21T00:00:00.000Z')
  })

  it('refuses an argument it does not recognise rather than ignoring it', () => {
    expect(parseInsertArgs(['--venue', 'v', '--force'])).toEqual({
      ok: false,
      error: 'unrecognised argument: --force',
    })
  })
})

describe('decideAccountClaim', () => {
  it('claims an unclaimed account for a venue with no pointer', () => {
    expect(
      decideAccountClaim({
        targetVenueId: TARGET,
        targetAccountId: null,
        holderVenueId: null,
        tokenAccountId: ACCOUNT,
      }),
    ).toEqual({ action: 'claim' })
  })

  // Le Mil's on the day this ships: already pointed at the account the shared
  // token owns, so the insert adds a credential and moves no pointer.
  it('leaves a pointer alone when it already names this account', () => {
    expect(
      decideAccountClaim({
        targetVenueId: TARGET,
        targetAccountId: ACCOUNT,
        holderVenueId: TARGET,
        tokenAccountId: ACCOUNT,
      }),
    ).toEqual({ action: 'already_pointed' })
  })

  // THE CROSS-VENUE RULE, on the hand path. The callback enforces it too; a
  // script that did not would be the way around it.
  it('refuses an account another venue already holds, and names that venue', () => {
    const decision = decideAccountClaim({
      targetVenueId: TARGET,
      targetAccountId: null,
      holderVenueId: OTHER,
      tokenAccountId: ACCOUNT,
    })
    expect(decision.action).toBe('refuse')
    expect(decision.action === 'refuse' && decision.reason).toContain(OTHER)
  })

  // The direction that is easy to miss: the target venue is pointed somewhere
  // else. Storing the token would leave it receiving on one account and
  // sending on another.
  it('refuses when the venue is pointed at an account the token does not own', () => {
    const decision = decideAccountClaim({
      targetVenueId: TARGET,
      targetAccountId: '17841000000000000',
      holderVenueId: TARGET,
      tokenAccountId: ACCOUNT,
    })
    expect(decision.action).toBe('refuse')
    expect(decision.action === 'refuse' && decision.reason).toContain('receiving on one account')
  })

  // Both conflicts at once still refuses, and on the cross-venue reason: that
  // is the one a person has to resolve first.
  it('reports the cross-venue conflict first when both apply', () => {
    const decision = decideAccountClaim({
      targetVenueId: TARGET,
      targetAccountId: '17841000000000000',
      holderVenueId: OTHER,
      tokenAccountId: ACCOUNT,
    })
    expect(decision.action === 'refuse' && decision.reason).toContain('already connected to a different venue')
  })
})

describe('describeGraphFailure', () => {
  // The whole reason this is a switch: two of the four members have no
  // httpStatus, and a template over it prints "HTTP undefined" on a timeout —
  // a message that reads like a real status and is not one.
  it('never invents an HTTP status for a failure that has none', () => {
    expect(describeGraphFailure({ reason: 'timeout' })).toBe('the request to Meta timed out')
    expect(describeGraphFailure({ reason: 'timeout' })).not.toContain('undefined')
    expect(
      describeGraphFailure({ reason: 'network', errorName: 'TypeError', causeCode: 'ECONNRESET' }),
    ).not.toContain('undefined')
  })

  it('renders a graph error by its codes', () => {
    expect(
      describeGraphFailure({
        reason: 'graph_error',
        httpStatus: 400,
        code: 190,
        subcode: 463,
        type: 'OAuthException',
        fbtraceId: 'trace-1',
      }),
    ).toBe('Meta refused it (HTTP 400, code 190/463)')
  })

  // Meta's error MESSAGE quotes the object it failed on, which for these calls
  // is the token or the account. The module that produces GraphFailure never
  // carries it, and this renderer must not reintroduce it by another route.
  it('carries no fbtraceId or error type into the message a person sees', () => {
    const rendered = describeGraphFailure({
      reason: 'graph_error',
      httpStatus: 400,
      code: 190,
      subcode: null,
      type: 'OAuthException',
      fbtraceId: 'SECRET-TRACE',
    })
    expect(rendered).not.toContain('SECRET-TRACE')
    expect(rendered).not.toContain('OAuthException')
  })

  it('reports a malformed response as a shape problem, not a refusal', () => {
    expect(describeGraphFailure({ reason: 'malformed_response', httpStatus: 200 })).toContain(
      'could not read',
    )
  })
})
