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

import { captureClassificationLowConfidence, captureDemoBypassedApprovalGate } from './posthog'

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
