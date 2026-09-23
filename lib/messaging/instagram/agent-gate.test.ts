// The gate that decides whether the agent replies to an Instagram guest
// (TAC-469), and — since TAC-523 — what the ledger records when it does not.
// Three separate rules, tested separately:
//   - the gate itself: nothing is handed over while it is shut, and a shut
//     gate is now RECORDED rather than silent;
//   - the kind check, which stays: an echo, a read receipt or a duplicate is
//     never handed over, even with the gate open;
//   - the turn/not-a-turn split, which is what keeps the ledger's denominator
//     meaningful.

import { describe, expect, it } from 'vitest'

import { INSTAGRAM_AGENT_REPLIES_ENABLED, resolveAgentHandoff } from './agent-gate'
import type { InstagramEventOutcome } from './handle-events'

const saved = (kind: 'message' | 'postback' | 'echo'): InstagramEventOutcome => ({
  status: 'persisted',
  kind,
  venueId: 'v',
  referralSource: null,
  guestId: 'g',
  messageId: `msg-${kind}`,
  guestCreated: false,
  hasReferral: false,
  hasProviderSentAt: true,
  titlelessPostback: false,
  guestCreatedVia: null,
})

/**
 * Not inbound turns. Recording any of these would inflate the denominator the
 * ledger exists to provide — the venue's own message coming back, a receipt,
 * a redelivery of a turn already counted, and events that are not messages.
 */
const notATurn: Array<[string, InstagramEventOutcome]> = [
  ['an echo', saved('echo')],
  ['a duplicate message', { status: 'duplicate', kind: 'message', venueId: 'v', messageId: 'msg-1' }],
  ['a read receipt', { status: 'read', venueId: 'v', guestId: 'g', messageId: 'msg-1' }],
  ['a comment on a post', { status: 'unhandled', reason: 'changes_field', fields: ['comments'] }],
  // Its own comment in parse-events.ts is "reaction, message_edit, handover" —
  // NOT a guest message. Named here because a code review read this reason as
  // the one carrying voice notes; it is not, `message_unsupported` is.
  ['a reaction or an edit', { status: 'unhandled', reason: 'unhandled_messaging_type', fields: [] }],
  ['a standalone referral', { status: 'unhandled', reason: 'standalone_referral', fields: [] }],
  // The guest withdrew it, so nothing is owed by the time we see it.
  ['a message the guest unsent', { status: 'unhandled', reason: 'message_deleted', fields: [] }],
  ['a failed echo save', { status: 'failed', kind: 'echo', stage: 'message_insert', error: 'x', code: null, venueId: 'v' }],
]

/** Guest turns the agent will never see. Every one of these must leave a row. */
const lostTurns: Array<[string, InstagramEventOutcome]> = [
  ['a message we could not route to a venue', { status: 'skipped', kind: 'message', reason: 'venue_not_found', venueId: null }],
  ['a postback from a guest we do not know', { status: 'skipped', kind: 'postback', reason: 'unknown_guest', venueId: 'v' }],
  ['a message whose save failed', { status: 'failed', kind: 'message', stage: 'message_insert', error: 'x', code: null, venueId: 'v' }],
]

/**
 * Guest messages that reach us and are saved NOWHERE — Meta could not render
 * them, or they carried neither text nor an attachment. CLAUDE.md notes a STOP
 * sent as a voice note would have been invisible. Counting these as non-turns
 * would under-report the denominator in the one case where the guest got
 * silence, which is what the ledger exists to surface.
 */
const unrenderable: Array<[string, InstagramEventOutcome]> = [
  ['a voice note or sticker Meta could not render', { status: 'unhandled', reason: 'message_unsupported', fields: [] }],
  ['a message with no text and no attachment', { status: 'unhandled', reason: 'message_no_content', fields: [] }],
]

describe('the Instagram agent gate', () => {
  // Flipped by TAC-469's PR C, together with this assertion. Pinned rather
  // than left implicit so turning replies back off is a deliberate edit to a
  // test that says so, not a silent constant change.
  it('is OPEN: the agent replies to Instagram guests (TAC-469)', () => {
    expect(INSTAGRAM_AGENT_REPLIES_ENABLED).toBe(true)
  })

  it('hands a newly saved guest message or postback to the agent by default', () => {
    expect(resolveAgentHandoff(saved('message'))).toEqual({ kind: 'run', messageId: 'msg-message' })
    expect(resolveAgentHandoff(saved('postback'))).toEqual({ kind: 'run', messageId: 'msg-postback' })
  })

  it('hands a newly saved guest message or postback to the agent once open', () => {
    expect(resolveAgentHandoff(saved('message'), true)).toEqual({
      kind: 'run',
      messageId: 'msg-message',
    })
  })

  it.each(notATurn)('treats %s as not a turn, even once open', (_name, outcome) => {
    expect(resolveAgentHandoff(outcome, true)).toEqual({ kind: 'not_a_turn' })
  })

  // TAC-469: an icebreaker tap Meta sent with no title is an empty inbound;
  // there is nothing to reply to. The row is still saved and still opens the
  // reply window; only the agent run is skipped — and since TAC-523 the skip
  // is on the record.
  it('records a titleless postback rather than dropping it silently', () => {
    const titleless = { ...saved('postback'), titlelessPostback: true } as InstagramEventOutcome
    expect(resolveAgentHandoff(titleless, true)).toEqual({
      kind: 'record',
      reason: 'titleless_postback',
    })
  })
})

describe('a shut gate is recorded, not silent (TAC-523)', () => {
  // The 2026-09-20 incident: a guest's first message, saved, and dropped
  // because this gate was still false in the deployment serving the request.
  // Nothing recorded it. Driven by the PARAMETER rather than the constant,
  // because the parameter is what a rollback restores.
  it('records a guest message dropped by a shut gate', () => {
    expect(resolveAgentHandoff(saved('message'), false)).toEqual({
      kind: 'record',
      reason: 'gate_shut',
    })
    expect(resolveAgentHandoff(saved('postback'), false)).toEqual({
      kind: 'record',
      reason: 'gate_shut',
    })
  })

  it('still treats an echo as not a turn when shut, rather than a lost guest message', () => {
    // Ordering inside the resolver: the echo check runs BEFORE the gate check.
    // Reversed, a shut gate would report the venue's own messages as dropped
    // guest turns and the incident count would be nonsense.
    expect(resolveAgentHandoff(saved('echo'), false)).toEqual({ kind: 'not_a_turn' })
  })

  it.each(lostTurns)('records %s as a lost turn', (_name, outcome) => {
    expect(resolveAgentHandoff(outcome, true)).toEqual({
      kind: 'record',
      reason: 'event_not_persisted',
    })
  })

  it.each(unrenderable)('records %s, which reaches us and is saved nowhere', (_name, outcome) => {
    expect(resolveAgentHandoff(outcome, true)).toEqual({
      kind: 'record',
      reason: 'message_unrenderable',
    })
  })

  it('does not throw on a status outside the union, which would abandon the delivery', () => {
    // The route resolves inside a loop over a batched entry[] x messaging[]
    // delivery. Before the guard, an index miss threw and every REMAINING
    // outcome was skipped — no agent run, no profile refresh, no ledger row.
    // Reachable only via a cast today; the cost is what makes it worth a line.
    const bogus = { status: 'invented_later' } as unknown as InstagramEventOutcome
    expect(resolveAgentHandoff(bogus, true)).toEqual({ kind: 'not_a_turn' })
  })
})
