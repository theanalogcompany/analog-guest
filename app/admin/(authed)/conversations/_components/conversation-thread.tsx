'use client'

import { formatInTimeZone } from 'date-fns-tz'
import { useEffect, useRef } from 'react'
import { type BubblePosition, MessageBubble } from './message-bubble'

// iMessage-style thread layout. Bubbles are clickable; the parent owns the
// selection state and trace-panel coordination. Sequence collapsing: when
// the previous bubble is same-direction and within SEQUENCE_GAP_MS, render
// without a tail so the chain reads as one block. When the gap exceeds
// SEQUENCE_GAP_MS *or* direction flips, render a centered timestamp row
// above the next bubble.
//
// Auto-scroll: on mount and on new-message append, scroll to bottom — but
// only if the user is already near the bottom. Don't yank them if they've
// scrolled up to read history.

const SEQUENCE_GAP_MS = 60 * 1000
const TIMESTAMP_GAP_MS = 5 * 60 * 1000  // Show centered timestamp row when gap exceeds 5 min
const NEAR_BOTTOM_PX = 120

export interface ThreadMessage {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  createdAt: Date
  langfuseTraceId: string | null
  replyToMessageId: string | null
}

interface ConversationThreadProps {
  messages: ThreadMessage[]
  venueTimezone: string
  selectedMessageId: string | null
  onSelectMessage: (id: string) => void
}

export function ConversationThread({
  messages,
  venueTimezone,
  selectedMessageId,
  onSelectMessage,
}: ConversationThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastMessageIdRef = useRef<string | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const last = messages[messages.length - 1]
    if (!last) return
    if (last.id === lastMessageIdRef.current) return
    // Only auto-scroll if user is near the bottom — don't yank mid-read.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const isInitialMount = lastMessageIdRef.current === null
    if (isInitialMount || distanceFromBottom < NEAR_BOTTOM_PX) {
      el.scrollTop = el.scrollHeight
    }
    lastMessageIdRef.current = last.id
  }, [messages])

  // Pre-compute positions + timestamp insertions in a single pass to keep the
  // render loop straightforward.
  const items = computeItems(messages)

  return (
    <div
      ref={scrollRef}
      // 400px column caps thread width to iPhone-realistic dimensions; the
      // surrounding grid leaves the rest of the page for the trace panel.
      // gap-0.5 (2px) between bubbles matches iMessage chain density.
      className="w-full max-w-[400px] h-full overflow-y-auto bg-paper py-4 flex flex-col gap-0.5"
    >
      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-ink-soft">
          No messages yet for this guest at this venue.
        </div>
      ) : null}
      {items.map((item) => {
        if (item.kind === 'timestamp') {
          return (
            <div
              key={`ts-${item.atIso}`}
              className="text-center text-xs text-ink-soft py-2"
            >
              {formatInTimeZone(new Date(item.atIso), venueTimezone, 'h:mm a · EEE MMM d')}
            </div>
          )
        }
        return (
          <MessageBubble
            key={item.message.id}
            body={item.message.body}
            direction={item.message.direction}
            createdAt={item.message.createdAt}
            venueTimezone={venueTimezone}
            position={item.position}
            selected={item.message.id === selectedMessageId}
            onSelect={() => onSelectMessage(item.message.id)}
          />
        )
      })}
    </div>
  )
}

type ThreadItem =
  | { kind: 'timestamp'; atIso: string }
  | { kind: 'bubble'; message: ThreadMessage; position: BubblePosition }

function computeItems(messages: ThreadMessage[]): ThreadItem[] {
  const items: ThreadItem[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const prev = messages[i - 1]
    const next = messages[i + 1]

    // Insert centered timestamp row when there's a sustained gap or direction flip
    // with notable elapsed time. First message always gets a timestamp row above.
    if (
      !prev ||
      m.createdAt.getTime() - prev.createdAt.getTime() > TIMESTAMP_GAP_MS
    ) {
      items.push({ kind: 'timestamp', atIso: m.createdAt.toISOString() })
    }

    const samePrev =
      prev &&
      prev.direction === m.direction &&
      m.createdAt.getTime() - prev.createdAt.getTime() <= SEQUENCE_GAP_MS
    const sameNext =
      next &&
      next.direction === m.direction &&
      next.createdAt.getTime() - m.createdAt.getTime() <= SEQUENCE_GAP_MS

    let position: BubblePosition
    if (!samePrev && !sameNext) position = 'only'
    else if (!samePrev && sameNext) position = 'first'
    else if (samePrev && sameNext) position = 'middle'
    else position = 'last'

    items.push({ kind: 'bubble', message: m, position })
  }
  return items
}
