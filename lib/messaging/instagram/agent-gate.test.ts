// The gate that keeps the agent from replying to Instagram guests until
// outbound exists (TAC-469). Two separate rules, tested separately:
//   - the gate itself, which TAC-469 removes: nothing is handed over while it
//     is shut;
//   - the kind check, which stays: an echo, a read receipt or a duplicate is
//     never handed over, even with the gate open.

import { describe, expect, it } from 'vitest'

import { agentMessageIdFor, INSTAGRAM_AGENT_REPLIES_ENABLED } from './agent-gate'
import type { InstagramEventOutcome } from './handle-events'

const saved = (kind: 'message' | 'postback' | 'echo'): InstagramEventOutcome => ({
  status: 'persisted',
  kind,
  venueId: 'v',
  guestId: 'g',
  messageId: `msg-${kind}`,
  guestCreated: false,
  hasReferral: false,
  hasProviderSentAt: true,
  titlelessPostback: false,
  guestCreatedVia: null,
})

const notSaved: Array<[string, InstagramEventOutcome]> = [
  ['an echo', saved('echo')],
  ['a duplicate message', { status: 'duplicate', kind: 'message', venueId: 'v', messageId: 'msg-1' }],
  ['a read receipt', { status: 'read', venueId: 'v', guestId: 'g', messageId: 'msg-1' }],
  ['a skipped message', { status: 'skipped', kind: 'message', reason: 'venue_not_found' }],
  ['a failed message', { status: 'failed', kind: 'message', stage: 'message_insert', error: 'x', code: null }],
  ['an unhandled event', { status: 'unhandled', reason: 'changes_field', fields: ['comments'] }],
]

describe('the Instagram agent gate', () => {
  // Flipped by TAC-469's PR C, together with this assertion. Pinned rather
  // than left implicit so turning replies back off is a deliberate edit to a
  // test that says so, not a silent constant change.
  it('is OPEN: the agent replies to Instagram guests (TAC-469)', () => {
    expect(INSTAGRAM_AGENT_REPLIES_ENABLED).toBe(true)
  })

  it('hands a newly saved guest message or postback to the agent by default', () => {
    expect(agentMessageIdFor(saved('message'))).toBe('msg-message')
    expect(agentMessageIdFor(saved('postback'))).toBe('msg-postback')
  })

  // The shut behaviour keeps its own coverage, driven by the parameter rather
  // than the constant: this is what a rollback restores, and it is also what
  // every caller gets if the constant is ever made per-venue.
  it('hands nothing to the agent when shut, not even a new guest message', () => {
    expect(agentMessageIdFor(saved('message'), false)).toBeNull()
    expect(agentMessageIdFor(saved('postback'), false)).toBeNull()
  })

  it('hands a newly saved guest message or postback to the agent once open', () => {
    expect(agentMessageIdFor(saved('message'), true)).toBe('msg-message')
    expect(agentMessageIdFor(saved('postback'), true)).toBe('msg-postback')
  })

  it.each(notSaved)('never hands %s to the agent, even once open', (_name, outcome) => {
    expect(agentMessageIdFor(outcome, true)).toBeNull()
  })

  // TAC-469: an icebreaker tap Meta sent with no title is an empty inbound;
  // there is nothing to reply to. The row is still saved and still opens the
  // reply window; only the agent run is skipped.
  it('never hands a titleless postback to the agent, even once open', () => {
    const titleless = { ...saved('postback'), titlelessPostback: true } as InstagramEventOutcome
    expect(agentMessageIdFor(titleless, true)).toBeNull()
  })
})
