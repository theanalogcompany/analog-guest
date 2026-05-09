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

import { captureClassificationLowConfidence } from './posthog'

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
