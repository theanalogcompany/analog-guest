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
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
  captureClassificationLowConfidence,
  captureConversationChannelUnresolved,
  captureDemoBypassedApprovalGate,
  captureDraftDropped,
  capturePendingSlotInvariantBroken,
  formatDraftDropped,
  isAgentLatencyHigh,
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
    expect(args.properties.wouldHaveQueuedTriggers).toEqual([
      'fidelity_below_auto_send_floor',
    ])
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
    droppedCommitment: {
      type: 'comp',
      description: 'a free croissant',
      code: null,
    },
    triggers: ['commitment_type_gated'],
    kind: 'inbound' as const,
    category: 'comp_complaint',
    droppedBody: 'So sorry. A croissant on us next time.',
  }

  // The ruling: whoever reads this may be reading it mid-incident, so it names
  // which offer was kept, which was dropped, and which guest, without a lookup.
  it('names both commitments, their codes, and the guest by first name and last four digits', () => {
    const text = formatDraftDropped(PROPS)
    expect(text).toContain(
      '*Draft dropped: this guest already has a different offer waiting* (inbound)',
    )
    expect(text).toContain('guest: Sam, phone ending 0123 (`g-1`)')
    expect(text).toContain(
      'kept, pending card `card-a`: comp "a free cortado on your next visit" (code 7K2P)',
    )
    expect(text).toContain(
      'dropped, never saved: comp "a free croissant" (no code)',
    )
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
    expect(args.properties.protectedCommitment).toEqual(
      PROPS.protectedCommitment,
    )
    expect(args.properties.droppedCommitment).toEqual(PROPS.droppedCommitment)
  })

  it('still identifies a guest with no name and no number', () => {
    const text = formatDraftDropped({
      ...PROPS,
      guestFirstName: null,
      guestPhone: null,
    })
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

    const args = captureMock.mock.calls[0][0] as {
      event: string
      properties: Record<string, unknown>
    }
    expect(args.event).toBe('pending_slot_invariant_broken')
    expect(args.properties.extraIds).toEqual(['card-b'])
    expect(postToSlackMock).toHaveBeenCalledTimes(1)
    const text = postToSlackMock.mock.calls[0][0] as string
    expect(text).toContain('two pending cards in one slot')
    expect(text).toContain('`card-b`')
  })
})

describe('captureConversationChannelUnresolved: a reply that cannot be routed (TAC-469)', () => {
  const base = {
    agentRunId: 'run-1',
    venueId: 'venue-1',
    guestId: 'guest-1',
    inboundMessageId: 'msg-1',
    inboundChannel: 'text' as const,
    hasPhone: false,
    hasInstagramId: true,
    reason: 'inbound_channel_without_identifier',
  }

  it('captures to PostHog AND relays to Slack, with the reason', async () => {
    await captureConversationChannelUnresolved(base)
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation_channel_unresolved',
        distinctId: 'guest-1',
        properties: expect.objectContaining({
          reason: 'inbound_channel_without_identifier',
          inboundChannel: 'text',
        }),
      }),
    )
    expect(postToSlackMock).toHaveBeenCalledTimes(1)
    const text = postToSlackMock.mock.calls[0]![0] as string
    expect(text).toContain('inbound_channel_without_identifier')
    expect(text).toContain("can't be routed")
  })

  it('names a run with no inbound message and an unparseable channel apart', async () => {
    await captureConversationChannelUnresolved({
      ...base,
      inboundMessageId: null,
      inboundChannel: undefined,
    })
    await captureConversationChannelUnresolved({
      ...base,
      inboundChannel: null,
    })
    const channels = captureMock.mock.calls.map(
      (c) =>
        (c[0] as { properties: { inboundChannel: string } }).properties
          .inboundChannel,
    )
    expect(channels).toEqual(['none', 'unparseable'])
  })
})

describe('agent_latency_high: thresholds and the absence of a Slack relay', () => {
  // This alarm shipped with a single 10_000ms threshold and a Slack relay, and
  // had NO test coverage at all — which is how it ran for months firing on
  // 99.3% of inbound turns (274/276 over the 30d window to 2026-09-29) into the
  // channel people are supposed to read. The gap was the coverage, not the number.

  const base = {
    agentRunId: 'run-1',
    venueId: 'v-1',
    guestId: 'guest-1',
    inboundBody: null,
    generatedBody: null,
  }

  it('does NOT relay to Slack, while still emitting the PostHog event', async () => {
    // The assertion this file exists for. A per-run threshold cannot be both
    // sensitive and quiet, so the real-time channel is not the right sink; the
    // aggregate alert lives in Langfuse. Asserts BOTH halves, because a mistake
    // that silently dropped the PostHog event too would leave no forensics.
    await captureAgentLatencyHigh({
      ...base,
      totalElapsedMs: 40_000,
      kind: 'inbound',
    })
    expect(postToSlackMock).not.toHaveBeenCalled()
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent_latency_high',
        distinctId: 'guest-1',
        properties: expect.objectContaining({
          totalElapsedMs: 40_000,
          kind: 'inbound',
        }),
      }),
    )
  })

  it('uses a different threshold per kind', async () => {
    // Not an equality check against the literals — that is a derivation against
    // itself. The claim under test is that the two are NOT the same number,
    // because a single shared threshold is the original defect: inbound p50 is
    // 18.0s against followup p50 0.2s, so one bar cannot serve both.
    expect(AGENT_LATENCY_HIGH_THRESHOLD_MS.inbound).not.toBe(
      AGENT_LATENCY_HIGH_THRESHOLD_MS.followup,
    )
    expect(AGENT_LATENCY_HIGH_THRESHOLD_MS.inbound).toBeGreaterThan(
      AGENT_LATENCY_HIGH_THRESHOLD_MS.followup,
    )
  })

  it('sits above the measured p95 for each kind, so it is not firing on the body', async () => {
    // Measured p95: inbound 31.5s, followup 1.0s. A threshold at or below p95
    // means >=5% of all runs alarm, which is the noise the old value produced.
    expect(AGENT_LATENCY_HIGH_THRESHOLD_MS.inbound).toBeGreaterThan(31_500)
    expect(AGENT_LATENCY_HIGH_THRESHOLD_MS.followup).toBeGreaterThan(1_000)
  })

  it('stays reachable, so neither kind becomes a gate that cannot fire', async () => {
    // The opposite failure, and the one this repo warns about explicitly:
    // "distrust any gate whose true-positive history you cannot produce."
    // Observed maxima over the same window: inbound 68.5s, followup 21.9s.
    // A followup threshold of 25s would have been permanently dead.
    expect(AGENT_LATENCY_HIGH_THRESHOLD_MS.inbound).toBeLessThan(68_500)
    expect(AGENT_LATENCY_HIGH_THRESHOLD_MS.followup).toBeLessThan(21_900)
  })

  it('isAgentLatencyHigh reads the threshold for the kind it was given', async () => {
    const { inbound, followup } = AGENT_LATENCY_HIGH_THRESHOLD_MS
    // Straddle each bar. The cross-kind pair is the important one: an elapsed
    // time between the two thresholds must be high for followup and NOT high
    // for inbound. A helper that ignored `kind` passes every same-kind check.
    const between = Math.floor((followup + inbound) / 2)
    expect(isAgentLatencyHigh('followup', between)).toBe(true)
    expect(isAgentLatencyHigh('inbound', between)).toBe(false)

    expect(isAgentLatencyHigh('inbound', inbound + 1)).toBe(true)
    expect(isAgentLatencyHigh('inbound', inbound)).toBe(false)
    expect(isAgentLatencyHigh('followup', followup + 1)).toBe(true)
    expect(isAgentLatencyHigh('followup', followup)).toBe(false)
  })
})
