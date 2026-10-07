'use client'

import { replyBubblesOf } from '../_lib/history'
import type { PlaygroundTurn } from '../_lib/types'

// Bubble rendering for playground turns, shared by the sandbox chat and the
// replay results. Same visual language as the conversations viewer's
// message-bubble.tsx: venue/agent in iMessage blue, guest in iMessage
// incoming gray - the operator should read the exchange the way they would
// holding the venue's phone. Hex values are Apple's palette verbatim, not
// brand tokens (that file's ruling).

const GUEST_BUBBLE: React.CSSProperties = {
  backgroundColor: '#E9E9EB',
  color: '#000000',
}
const VENUE_BUBBLE: React.CSSProperties = {
  backgroundColor: '#007AFF',
  color: '#FFFFFF',
}

export function GuestBubbles({ texts }: { texts: string[] }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      {texts.map((text, i) => (
        <div
          key={i}
          className="max-w-[75%] whitespace-pre-wrap break-words rounded-[18px] rounded-bl-[4px] px-3 py-1.5 text-[14px] leading-[1.3]"
          style={GUEST_BUBBLE}
        >
          {text}
        </div>
      ))}
    </div>
  )
}

/**
 * One turn's v2 reply (or its failure), clickable to drive the inspector.
 * A failed run renders as a flat error strip in the same slot - the error
 * belongs to the turn, and selecting it shows the full detail on the right.
 */
export function TurnReply({
  turn,
  selected,
  onSelect,
}: {
  turn: PlaygroundTurn
  selected: boolean
  onSelect: () => void
}) {
  if (turn.status === 'running') {
    return (
      <div className="flex justify-end">
        <div className="rounded-[18px] rounded-br-[4px] bg-parchment px-3 py-1.5 text-[13px] italic text-ink-faint">
          running the turn (15-45s, three model calls)
        </div>
      </div>
    )
  }

  if (turn.status === 'error') {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSelect}
          className={`max-w-[85%] cursor-pointer rounded-[2px] border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-left text-xs text-destructive ${
            selected
              ? 'ring-2 ring-clay/40 ring-offset-2 ring-offset-paper'
              : ''
          }`}
        >
          run failed: {turn.error ?? 'unknown error'}
        </button>
      </div>
    )
  }

  // A restored turn has bubbles and no trace; a live turn has a trace. Both
  // reach the same render below, so a saved conversation reads identically to
  // one just run - except for the no-trace note, which must stay visible.
  const restored = turn.response === undefined ? turn.restored : undefined
  const generation = turn.response?.trace.generation
  if (restored === undefined && !generation?.ok) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSelect}
          className={`max-w-[85%] cursor-pointer rounded-[2px] border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-left text-xs text-destructive ${
            selected
              ? 'ring-2 ring-clay/40 ring-offset-2 ring-offset-paper'
              : ''
          }`}
        >
          generation failed: {generation?.error ?? 'no generation on trace'}
        </button>
      </div>
    )
  }

  // The one definition of "this turn's reply bubbles", shared with the
  // transcript builder - rendering text the next prompt does not carry is
  // exactly the divergence that helper exists to prevent.
  const bubbles = replyBubblesOf(turn)
  const verdict = restored?.verdict ?? turn.response?.trace.gate?.verdict

  // A saved turn whose run produced nothing is saved as producing nothing
  // (schemas/playground.ts). Render that rather than an empty slot, so the
  // conversation does not read as if the venue simply said nothing back.
  if (bubbles.length === 0) {
    return (
      <div className="flex justify-end">
        <span className="text-[11px] italic text-ink-faint">
          no reply was generated on this turn
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      {bubbles.map((text, i) => (
        <button
          key={i}
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className={`max-w-[75%] cursor-pointer whitespace-pre-wrap break-words rounded-[18px] rounded-br-[4px] px-3 py-1.5 text-left text-[14px] leading-[1.3] ${
            selected
              ? 'ring-2 ring-clay/40 ring-offset-2 ring-offset-paper'
              : ''
          }`}
          style={VENUE_BUBBLE}
        >
          {text}
        </button>
      ))}
      {verdict && verdict !== 'send' && (
        <span className="pt-0.5 text-[11px] italic text-ink-soft">
          gate: {verdict}
        </span>
      )}
      {restored !== undefined && (
        <span className="pt-0.5 text-[11px] italic text-ink-faint">
          restored - rerun to inspect
        </span>
      )}
      {turn.previousTrace && (
        <span className="pt-0.5 text-[11px] italic text-ink-faint">
          regenerated - inspector compares judge scores
        </span>
      )}
    </div>
  )
}

/** Replay mode: the production v1 reply that actually followed the inbound. */
export function V1ActualReply({ bubbles }: { bubbles: string[] | null }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint">
        what v1 actually sent
      </span>
      {bubbles === null ? (
        <span className="text-xs italic text-ink-faint">
          no outbound followed this message in production
        </span>
      ) : (
        bubbles.map((text, i) => (
          <div
            key={i}
            className="max-w-[75%] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[4px] border border-stone-light bg-paper px-3 py-1.5 text-[14px] leading-[1.3] text-ink-soft"
          >
            {text}
          </div>
        ))
      )}
    </div>
  )
}
