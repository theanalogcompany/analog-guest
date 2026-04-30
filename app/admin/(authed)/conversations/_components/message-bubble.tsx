'use client'

import { formatInTimeZone } from 'date-fns-tz'

// iMessage-style bubble. Brand discipline yields to fitness-for-purpose on
// internal debugging surfaces — operator should see the conversation the way
// the guest sees it. Real iMessage palette (#007AFF / #E5E5EA), Inter Tight
// inside (don't load San Francisco for one component).
//
// Sequence collapsing: when this bubble is part of a chain (same direction,
// within 60s of the previous), the outer corner gets squared off so the chain
// reads as a single block. Tail/non-tail decisions live on the parent thread
// component — this component just receives `position`.

export type BubblePosition = 'first' | 'middle' | 'last' | 'only'
export type BubbleDirection = 'inbound' | 'outbound'

interface MessageBubbleProps {
  body: string
  direction: BubbleDirection
  createdAt: Date
  venueTimezone: string
  position: BubblePosition
  selected: boolean
  // Why disabled: outbound rows without langfuse_trace_id (pre-THE-200 history,
  // capture-off venues, etc.) have nothing to render in the trace panel. We
  // still let the operator click — the panel renders a "no trace available"
  // message, which is more informative than a dead bubble.
  onSelect: () => void
}

export function MessageBubble({
  body,
  direction,
  createdAt,
  venueTimezone,
  position,
  selected,
  onSelect,
}: MessageBubbleProps) {
  const isOutbound = direction === 'outbound'

  // Tail-side corner squared on `last` / `only`; inner corners squared on
  // chain members so consecutive bubbles read as a connected block.
  const cornerClasses = (() => {
    const base = 'rounded-[18px]'
    if (position === 'only') {
      return isOutbound
        ? `${base} rounded-br-[4px]`
        : `${base} rounded-bl-[4px]`
    }
    if (position === 'first') {
      return isOutbound
        ? `${base} rounded-br-[4px]`
        : `${base} rounded-bl-[4px]`
    }
    if (position === 'middle') {
      return isOutbound
        ? `${base} rounded-tr-[4px] rounded-br-[4px]`
        : `${base} rounded-tl-[4px] rounded-bl-[4px]`
    }
    // 'last'
    return isOutbound
      ? `${base} rounded-tr-[4px]`
      : `${base} rounded-tl-[4px]`
  })()

  const colorStyles: React.CSSProperties = isOutbound
    ? { backgroundColor: '#007AFF', color: '#FFFFFF' }
    : { backgroundColor: '#E5E5EA', color: 'var(--color-ink, #1F1B16)' }

  const align = isOutbound ? 'justify-end' : 'justify-start'

  // Time tooltip on hover. iMessage shows time after a short delay; web hover
  // tooltip is the cheapest equivalent.
  const tooltipTime = formatInTimeZone(
    createdAt,
    venueTimezone,
    'h:mm a · EEE MMM d',
  )

  return (
    <div className={`flex ${align} px-2`}>
      <button
        type="button"
        onClick={onSelect}
        title={tooltipTime}
        className={[
          cornerClasses,
          'max-w-[min(70%,32rem)]',
          'px-4 py-2',
          'text-base leading-snug',
          'transition-transform',
          'cursor-pointer',
          'text-left',
          'whitespace-pre-wrap',
          'break-words',
          selected
            ? 'ring-2 ring-clay/40 ring-offset-2 ring-offset-paper scale-[1.01]'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={colorStyles}
        aria-pressed={selected}
        data-message-direction={direction}
      >
        {body}
      </button>
    </div>
  )
}
