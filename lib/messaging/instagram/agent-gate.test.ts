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
  // TAC-469 flips this, and this assertion with it.
  it('is shut until Instagram outbound exists (TAC-469)', () => {
    expect(INSTAGRAM_AGENT_REPLIES_ENABLED).toBe(false)
  })

  it('hands nothing to the agent while shut, not even a new guest message', () => {
    expect(agentMessageIdFor(saved('message'))).toBeNull()
    expect(agentMessageIdFor(saved('postback'))).toBeNull()
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
