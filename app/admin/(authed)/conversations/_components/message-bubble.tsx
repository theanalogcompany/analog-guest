'use client'

import { formatInTimeZone } from 'date-fns-tz'
import { StatusDot } from '@/lib/ui'

// iMessage-style bubble. Brand discipline yields to fitness-for-purpose on
// internal debugging surfaces — operator should see the conversation the way
// they would if holding the venue's phone: their own (venue/agent) messages
// in iMessage blue (#007AFF), the other party's (guest) messages in iMessage
// incoming gray (#E9E9EB). The earlier flip (THE-223) had the colors reversed
// and used #E5E5EA for the gray, which reads as a lavender tint on most
// displays. Inter Tight inside (no SF font load).
//
// Sequence collapsing: when this bubble is part of a chain (same direction,
// within 60s of the previous), the outer corner gets squared off so the chain
// reads as a single block. Tail/non-tail decisions live on the parent thread
// component — this component just receives `position`.
//
// Reviewed indicator (THE-235): a small green StatusDot sibling sits to the
// right of outbound bubbles when response_review is non-null. Outside-the-
// bubble placement is deliberate — overlay marks fight the iMessage palette.
// Distinct from the selection ring (which is a clay focus ring on the bubble
// itself) so an operator can tell at a glance which messages have been
// reviewed AND which one they're currently inspecting.

export type BubblePosition = 'first' | 'middle' | 'last' | 'only'
export type BubbleDirection = 'inbound' | 'outbound'

interface MessageBubbleProps {
  body: string
  direction: BubbleDirection
  createdAt: Date
  venueTimezone: string
  position: BubblePosition
  selected: boolean
  /** True when messages.response_review is non-null. Outbound only — the form doesn't render for inbound, so the dot doesn't either. */
  reviewed: boolean
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
  reviewed,
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

  // Outbound (venue/agent = self) blue; inbound (guest = other) gray. See
  // file-top comment for the framing. Hex values are Apple's iMessage palette
  // verbatim — not brand tokens.
  const colorStyles: React.CSSProperties = isOutbound
    ? { backgroundColor: '#007AFF', color: '#FFFFFF' }
    : { backgroundColor: '#E9E9EB', color: '#000000' }

  const align = isOutbound ? 'justify-end' : 'justify-start'

  // Time tooltip on hover. iMessage shows time after a short delay; web hover
  // tooltip is the cheapest equivalent.
  const tooltipTime = formatInTimeZone(
    createdAt,
    venueTimezone,
    'h:mm a · EEE MMM d',
  )

  // gap-1.5 (6px) puts a hair of breathing room between the bubble's tail
  // edge and the reviewed dot without crowding. items-end aligns the dot
  // with the bubble's tail-corner so it tracks the chain visually.
  return (
    <div className={`flex items-end gap-1.5 ${align} px-2`}>
      <button
        type="button"
        onClick={onSelect}
        title={tooltipTime}
        className={[
          cornerClasses,
          // 75% of the 400px column ≈ 300px; matches iMessage's typical bubble
          // width within an iPhone-realistic viewport. The column itself caps
          // total width, so no absolute pixel ceiling needed here.
          'max-w-[75%]',
          // 14px matches Mac Messages.app body text — denser than the iOS
          // 15px we'd use on a phone, but this is a desktop debug surface
          // so legibility wins over phone-fidelity. leading-[1.3] kept.
          'px-3 py-1.5 text-[14px] leading-[1.3]',
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
      {/* Outbound-only. Inbound bubbles never get a review (form doesn't
          render on inbound) so we don't allocate space for the dot there.
          Padded down 4px so the dot aligns with the lower third of the
          bubble rather than the absolute baseline. */}
      {direction === 'outbound' && reviewed ? (
        <span className="pb-1" data-testid="reviewed-indicator">
          <StatusDot tone="good" label="Reviewed" />
        </span>
      ) : null}
    </div>
  )
}
