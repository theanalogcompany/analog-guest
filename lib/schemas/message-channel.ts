// TAC-495: which channel a message went through, as `messages.channel` holds it.
//
// 'text' is iMessage or SMS through the phone-number provider; 'instagram' is
// an Instagram message. The strict half is migration 048's
// messages_channel_check, which permits exactly these two; this list moves with
// it, and message-channel.test.ts reads the migration to hold them equal.
//
// Domain-free on purpose, like visit-precision.ts: lib/ai needs the type for
// GenerateMessageInput and must not depend on lib/agent, where the rule that
// picks a conversation's channel lives (conversation-channel.ts).
export const MESSAGE_CHANNELS = ['text', 'instagram'] as const

export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]

export function isMessageChannel(value: unknown): value is MessageChannel {
  return (MESSAGE_CHANNELS as readonly unknown[]).includes(value)
}

/**
 * Narrow a raw `messages.channel` value to `MessageChannel`, or null.
 *
 * Permissive at the live boundary, per CLAUDE.md's strict-offline /
 * permissive-live split: an unrecognized value degrades to null rather than
 * throwing inside an agent run. The CHECK constraint is the strict half, so
 * this only fires on a value the constraint was changed to allow without this
 * list moving too. Null is not a guess at either channel: the caller decides
 * what an unknown channel means.
 */
export function parseMessageChannel(value: string | null | undefined): MessageChannel | null {
  if (isMessageChannel(value)) return value
  if (value !== null && value !== undefined) {
    console.warn(`[message-channel] unrecognized channel "${value}", treating as unknown`)
  }
  return null
}
