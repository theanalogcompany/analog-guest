import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock both downstream sinks so no real network call goes out and we can
// inspect the Slack payload directly.
const postToSlackMock = vi.fn()
const captureMock = vi.fn()

vi.mock('./slack', async () => {
  const actual = await vi.importActual<typeof import('./slack')>('./slack')
  return {
    ...actual,
    postToSlack: (...args: unknown[]) => postToSlackMock(...args),
  }
})

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture(args: unknown) {
      captureMock(args)
    }
  },
}))

import {
  captureClassificationLowConfidence,
  captureDemoBypassedApprovalGate,
  captureDraftDropped,
  capturePendingSlotInvariantBroken,
  formatDraftDropped,
  phoneLast4,
} from './posthog'

beforeEach(() => {
  postToSlackMock.mockReset()
  captureMock.mockReset()
  // capturePostHogEvent reads NEXT_PUBLIC_POSTHOG_KEY before constructing
  // the client. Stub so the module doesn't throw.
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'test-key'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('captureClassificationLowConfidence — Slack formatter (TAC-240)', () => {
  it('does NOT include the auto-routed line when autoRoutedToUnknown is false', async () => {
    await captureClassificationLowConfidence({
      agentRunId: 'run-1',
      venueId: 'v-1',
      guestId: 'g-1',
      category: 'recommendation_request',
      classifierConfidence: 0.5,
      inboundLength: 12,
      inboundBody: 'whats good?',
      autoRoutedToUnknown: false,
    })
    expect(postToSlackMock).toHaveBeenCalledTimes(1)
    const text = postToSlackMock.mock.calls[0][0] as string
    expect(text).toContain('Classification low confidence')
    expect(text).toContain('`0.50`')
    expect(text).toContain('`recommendation_request`')
    expect(text).not.toContain('auto-routed')
    expect(text).not.toContain('holding ack')
  })

  it('includes the auto-routed action line when autoRoutedToUnknown is true', async () => {
    await captureClassificationLowConfidence({
      agentRunId: 'run-1',
      venueId: 'v-1',
      guestId: 'g-1',
      category: 'recommendation_request',
      classifierConfidence: 0.2,
      inboundLength: 5,
      inboundBody: 'hmm',
      autoRoutedToUnknown: true,
    })
    expect(postToSlackMock).toHaveBeenCalledTimes(1)
    const text = postToSlackMock.mock.calls[0][0] as string
    // Original category survives in the alert body.
    expect(text).toContain('`recommendation_request`')
    expect(text).toContain('auto-routed to: `unknown`')
    expect(text).toContain('agent shipped holding ack')
    expect(text).toContain('decide if a real reply is needed')
  })

  it('passes autoRoutedToUnknown through to the PostHog event', async () => {
    await captureClassificationLowConfidence({
      agentRunId: 'run-1',
      venueId: 'v-1',
      guestId: 'g-1',
      category: 'reply',
      classifierConfidence: 0.25,
      inboundLength: 3,
      inboundBody: 'yes',
      autoRoutedToUnknown: true,
    })
    expect(captureMock).toHaveBeenCalledTimes(1)
    const args = captureMock.mock.calls[0][0] as {
      event: string
      properties: { autoRoutedToUnknown: boolean; category: string }
    }
    expect(args.event).toBe('classification_low_confidence')
    expect(args.properties.autoRoutedToUnknown).toBe(true)
    expect(args.properties.category).toBe('reply')
  })
})

describe('captureDemoBypassedApprovalGate — conditional Slack relay (TAC-284)', () => {
  it('Slack-relays when comp_regex_backstop is among the would-have-queued triggers', async () => {
    await captureDemoBypassedApprovalGate({
      agentRunId: 'run-1',
      venueId: 'v-1',
      guestId: 'g-1',
      wouldHaveQueuedTriggers: ['comp_regex_backstop', 'model_flagged'],
      voiceFidelity: 0.82,
      generatedBody: "anyway, that one's on us today",
    })
    expect(postToSlackMock).toHaveBeenCalledTimes(1)
    const text = postToSlackMock.mock.calls[0][0] as string
    expect(text).toContain('Demo guest bypassed approval gate')
    expect(text).toContain('`comp_regex_backstop`')
  })

  it('does NOT Slack-relay for a fidelity-band-only bypass', async () => {
    await captureDemoBypassedApprovalGate({
      agentRunId: 'run-1',
      venueId: 'v-1',
      guestId: 'g-1',
      wouldHaveQueuedTriggers: ['fidelity_below_auto_send_floor'],
      voiceFidelity: 0.45,
      generatedBody: 'sure, see you then',
    })
    expect(postToSlackMock).not.toHaveBeenCalled()
  })

  it('does NOT Slack-relay for a model-flagged-only bypass', async () => {
    await captureDemoBypassedApprovalGate({
      agentRunId: 'run-1',
      venueId: 'v-1',
      guestId: 'g-1',
      wouldHaveQueuedTriggers: ['model_flagged'],
      voiceFidelity: 0.9,
      generatedBody: 'happy to set that aside for you',
    })
    expect(postToSlackMock).not.toHaveBeenCalled()
  })

  it('always fires the PostHog event regardless of Slack relay', async () => {
    await captureDemoBypassedApprovalGate({
      agentRunId: 'run-1',
      venueId: 'v-1',
      guestId: 'g-1',
      wouldHaveQueuedTriggers: ['fidelity_below_auto_send_floor'],
      voiceFidelity: 0.45,
      generatedBody: 'sure, see you then',
    })
    expect(captureMock).toHaveBeenCalledTimes(1)
    const args = captureMock.mock.calls[0][0] as {
      event: string
      properties: { wouldHaveQueuedTriggers: string[] }
    }
    expect(args.event).toBe('demo_bypassed_approval_gate')
    expect(args.properties.wouldHaveQueuedTriggers).toEqual(['fidelity_below_auto_send_floor'])
  })
})

describe('captureDraftDropped: names both offers and the guest (TAC-394)', () => {
  const PROPS = {
    agentRunId: 'run-1',
    venueId: 'v-1',
    guestId: 'g-1',
    guestFirstName: 'Sam',
    guestPhone: '+1 (555) 555-0123',
    reason: 'obligation_slot_taken' as const,
    protectedDraftId: 'card-a',
    protectedCommitment: {
      type: 'comp',
      description: 'a free cortado on your next visit',
      code: '7K2P',
    },
    droppedCommitment: { type: 'comp', description: 'a free croissant', code: null },
    triggers: ['commitment_type_gated'],
    kind: 'inbound' as const,
    category: 'comp_complaint',
    droppedBody: 'So sorry. A croissant on us next time.',
  }

  // The ruling: whoever reads this may be reading it mid-incident, so it names
  // which offer was kept, which was dropped, and which guest, without a lookup.
  it('names both commitments, their codes, and the guest by first name and last four digits', () => {
    const text = formatDraftDropped(PROPS)
    expect(text).toContain('*Draft dropped: this guest already has a different offer waiting* (inbound)')
    expect(text).toContain('guest: Sam, phone ending 0123 (`g-1`)')
    expect(text).toContain(
      'kept, pending card `card-a`: comp "a free cortado on your next visit" (code 7K2P)',
    )
    expect(text).toContain('dropped, never saved: comp "a free croissant" (no code)')
  })

  it('never puts the full phone number in Slack or PostHog', async () => {
    await captureDraftDropped(PROPS)

    const slack = postToSlackMock.mock.calls[0][0] as string
    const posthog = JSON.stringify(captureMock.mock.calls)
    for (const surface of [slack, posthog]) {
      expect(surface).not.toContain('555-0123')
      expect(surface).not.toContain('5555550123')
      expect(surface).not.toContain('(555)')
    }
    const args = captureMock.mock.calls[0][0] as {
      event: string
      properties: Record<string, unknown>
    }
    expect(args.event).toBe('draft_dropped')
    expect(args.properties).not.toHaveProperty('guestPhone')
    expect(args.properties.guestPhoneLast4).toBe('0123')
    expect(args.properties.protectedCommitment).toEqual(PROPS.protectedCommitment)
    expect(args.properties.droppedCommitment).toEqual(PROPS.droppedCommitment)
  })

  it('still identifies a guest with no name and no number', () => {
    const text = formatDraftDropped({ ...PROPS, guestFirstName: null, guestPhone: null })
    expect(text).toContain('guest: unnamed guest (`g-1`)')
  })

  it('says a card carries no commitment rather than leaving the line blank', () => {
    const text = formatDraftDropped({
      ...PROPS,
      reason: 'slot_occupied',
      protectedCommitment: null,
      droppedCommitment: null,
    })
    expect(text).toContain('waiting card `card-a`: no commitment')
  })

  it.each([
    ['+15555550123', '0123'],
    ['555', null],
    [null, null],
    ['', null],
  ])('phoneLast4(%s) is %s', (phone, expected) => {
    expect(phoneLast4(phone)).toBe(expected)
  })
})

describe('capturePendingSlotInvariantBroken: the indexes-are-gone signal (TAC-394)', () => {
  it('records the event and relays it to Slack', async () => {
    await capturePendingSlotInvariantBroken({
      venueId: 'v-1',
      guestId: 'g-1',
      keptObligationId: 'card-a',
      keptConversationId: null,
      extraIds: ['card-b'],
    })

    const args = captureMock.mock.calls[0][0] as { event: string; properties: Record<string, unknown> }
    expect(args.event).toBe('pending_slot_invariant_broken')
    expect(args.properties.extraIds).toEqual(['card-b'])
    expect(postToSlackMock).toHaveBeenCalledTimes(1)
    const text = postToSlackMock.mock.calls[0][0] as string
    expect(text).toContain('two pending cards in one slot')
    expect(text).toContain('`card-b`')
  })
})
