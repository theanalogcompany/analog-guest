'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { typingDelayMsFor } from '@/lib/relationship/bubble-pacing'
import type { TestDraft } from '@/lib/agent/handle-inbound'
// A value import, unlike the type-only ones: `lib/ai/v2/template.ts` has NO
// imports of its own (pure constants), so this pulls nothing server-side into
// the client bundle. The judge's axis list is declared locally for exactly the
// opposite reason - judge.ts drags the AI SDK in. Check before copying this.
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
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

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/**
 * Does this reader want motion?
 *
 * `useSyncExternalStore` rather than state-plus-effect so the answer is right
 * in the FIRST paint on the client. A staggered reveal is motion, and the
 * effect version would start revealing and then snap, which is the one outcome
 * a reduced-motion reader asked not to have. The server snapshot is false
 * because a media query has no answer there.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  )
}

/**
 * How many of this reply's bubbles have landed.
 *
 * ONE TIMEOUT AT A TIME, each scheduled from the moment the previous bubble
 * landed rather than from an absolute offset computed up front. That is what
 * bubbleDelaysFor's "these are gaps, not offsets" means in practice: the effect
 * re-runs on every reveal, so a slow render delays the next bubble instead of
 * compounding into the ones after it.
 *
 * `revealKey` carries the turn id AND its runSeq, so a regenerate replays the
 * arrival on a component that never unmounted. A rewind-and-rerun gets a new
 * turn id and so remounts anyway.
 *
 * Both resets are adjust-state-during-render, the documented pattern
 * chat-pane.tsx already uses for its prefill seq - state rather than a ref, and
 * not an effect, so the reveal restarts in the same paint instead of flashing
 * the finished reply first.
 */
function useRevealedCount(
  revealKey: string,
  bubbles: readonly string[],
  animate: boolean,
): number {
  const total = bubbles.length
  const start = animate && total > 0 ? 1 : total
  const [revealed, setRevealed] = useState(start)
  const [seenKey, setSeenKey] = useState(revealKey)

  if (seenKey !== revealKey) {
    setSeenKey(revealKey)
    setRevealed(start)
  } else if (!animate && revealed < total) {
    // Reduced motion turned on mid-reveal. Show the rest now; otherwise the
    // reveal stalls wherever it had got to and the reply reads as truncated.
    setRevealed(total)
  }

  const nextDelay =
    revealed < total ? typingDelayMsFor(bubbles[revealed] ?? '') : 0

  useEffect(() => {
    if (!animate || revealed >= total) return
    const timer = setTimeout(() => setRevealed((n) => n + 1), nextDelay)
    return () => clearTimeout(timer)
  }, [animate, revealed, total, nextDelay])

  // Clamped: a regenerate that returns fewer bubbles than the last run would
  // otherwise leave the count past the end for one paint.
  return revealed < total ? revealed : total
}

/** The pause between bubbles, so it reads as typing rather than as a stall. */
function TypingDots() {
  return (
    <div
      className="flex items-center gap-1 rounded-[18px] rounded-br-[4px] bg-parchment px-3 py-2"
      aria-label="typing"
    >
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 rounded-full bg-ink-faint motion-safe:animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  )
}

/**
 * The reply itself, revealed one bubble at a time.
 *
 * A SEPARATE COMPONENT because TurnReply returns early for running, errored
 * and failed-generation turns, and a hook cannot live after those. It also owns
 * the footnotes: each of them describes the WHOLE reply, so rendering one under
 * a half-arrived answer would caption something the reader cannot see yet.
 *
 * PRESENTATION ONLY. `replyBubblesOf` stays the one definition of this turn's
 * reply, and the transcript builder, the save and the inspector all keep
 * reading the full list. A revealed count reaching `sessionHistory` would mean
 * a guest message sent mid-reveal carried a truncated transcript into the next
 * prompt, which is exactly the divergence that helper exists to prevent.
 */
function RevealedReply({
  revealKey,
  bubbles,
  animate,
  selected,
  onSelect,
  onReveal,
  verdict,
  restored,
  regenerated,
}: {
  revealKey: string
  bubbles: string[]
  animate: boolean
  selected: boolean
  onSelect: () => void
  onReveal?: () => void
  verdict: 'send' | 'queue' | 'block' | null
  restored: boolean
  regenerated: boolean
}) {
  const reduced = usePrefersReducedMotion()
  const revealed = useRevealedCount(revealKey, bubbles, animate && !reduced)
  const done = revealed >= bubbles.length

  // The chat pane's autoscroll keys on `turns`, which does not change as
  // bubbles land, so without this the later ones arrive below the fold.
  useEffect(() => {
    onReveal?.()
  }, [revealed, onReveal])

  return (
    <div className="flex flex-col items-end gap-0.5">
      {bubbles.slice(0, revealed).map((text, i) => (
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
      {!done && <TypingDots />}
      {done && verdict && verdict !== 'send' && (
        <span className="pt-0.5 text-[11px] italic text-ink-soft">
          gate: {verdict}
        </span>
      )}
      {done && restored && (
        <span className="pt-0.5 text-[11px] italic text-ink-faint">
          restored - rerun to inspect
        </span>
      )}
      {done && regenerated && (
        <span className="pt-0.5 text-[11px] italic text-ink-faint">
          regenerated - inspector compares judge scores
        </span>
      )}
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
  onReveal,
}: {
  turn: PlaygroundTurn
  selected: boolean
  onSelect: () => void
  /** Called as each bubble lands, so the pane can keep the reply in view. */
  onReveal?: () => void
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
    <RevealedReply
      revealKey={`${turn.id}:${turn.runSeq}`}
      bubbles={bubbles}
      // A restore is review, not arrival: the operator opened a saved
      // conversation to read it, so pacing it would make them wait on text
      // that was already sent once.
      animate={restored === undefined}
      selected={selected}
      onSelect={onSelect}
      onReveal={onReveal}
      verdict={verdict ?? null}
      restored={restored !== undefined}
      regenerated={turn.previousTrace !== undefined}
    />
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

/** Outbound bubbles rendered flush left, for the side-by-side columns. */
function ColumnBubbles({
  bubbles,
  tone,
}: {
  bubbles: string[]
  /** 'v2' takes the live blue; 'v1' is outlined, so the eye lands on v2. */
  tone: 'v1' | 'v2'
}) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      {bubbles.map((text, i) => (
        <div
          key={i}
          className={`max-w-full whitespace-pre-wrap break-words rounded-[18px] rounded-bl-[4px] px-3 py-1.5 text-[14px] leading-[1.3] ${
            tone === 'v1'
              ? 'border border-stone-light bg-paper text-ink-soft'
              : ''
          }`}
          style={tone === 'v2' ? VENUE_BUBBLE : undefined}
        >
          {text}
        </div>
      ))}
    </div>
  )
}

/**
 * The substitute label: v1 answered this turn with something other than a
 * generated reply. Rendered as a statement of what v1 would have done, never
 * as an empty column - "v1 sends a fixed crisis message here" and "v1 had
 * nothing to say" are different answers and must not look alike.
 */
const SUBSTITUTE_COPY = {
  crisis_safety:
    'v1 short-circuits this turn: a fixed crisis-safety reply, never generated, and the approval gate never runs.',
  media_only_card:
    'v1 sends no text on this turn - it writes a blank card for the operator.',
  opt_out_confirmation:
    'v1 records the opt-out and sends its fixed confirmation. Not reproduced here: a test run must not write a TCPA opt-out.',
} satisfies Record<NonNullable<TestDraft['substitute']>, string>

/**
 * v1 and v2 side by side for one turn.
 *
 * The columns carry their prompt versions because that is what makes the
 * comparison legible: these are two engines AND two prompts, and a difference
 * attributed to the engine when it came from a prompt revision is the obvious
 * way to misread this surface.
 *
 * NO SCORES HERE, and that is a decision rather than an omission. The judge
 * scores v2's reply against v2's house notes; v1's prompt carried different
 * context, so judging it against v2's notes would penalize it for not using
 * facts it never saw. The operator reads the two replies.
 *
 * NO STAGGERED REVEAL HERE EITHER, unlike the standalone TurnReply. The
 * pacing exists to show what the guest's phone does; this surface answers a
 * different question - whether the two TEXTS differ - and the reader is
 * comparing them, not watching them arrive. Pacing only the v2 column would
 * also make v1 look instant beside it, which is a difference in the harness
 * rather than in the engine, and that is the one thing this surface must not
 * invent. Turning COMPARE off gets the paced single reply, unchanged.
 */
export function V1V2Columns({
  turn,
  selected,
  onSelect,
}: {
  turn: PlaygroundTurn
  selected: boolean
  onSelect: () => void
}) {
  const v1 = turn.response?.v1 ?? null
  if (v1 === null) return null

  const v2Bubbles = replyBubblesOf(turn)

  return (
    <div
      className={`mt-1 grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border bg-stone-light/60 ${
        selected
          ? 'border-clay/50 ring-2 ring-clay/40 ring-offset-2 ring-offset-paper'
          : 'border-stone-light/60'
      }`}
    >
      <div className="flex flex-col gap-1.5 bg-paper p-2.5">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          v1
          {v1.outcome.ok && (
            <span className="ml-1 normal-case tracking-normal text-ink-faint/80">
              {v1.outcome.data.promptVersion}
            </span>
          )}
        </span>
        {!v1.outcome.ok ? (
          <p className="text-xs text-destructive">
            v1 failed at {v1.outcome.stage}: {v1.outcome.error}
          </p>
        ) : (
          <>
            {v1.outcome.data.bubbles.length > 0 && (
              <ColumnBubbles bubbles={v1.outcome.data.bubbles} tone="v1" />
            )}
            {v1.outcome.data.substitute !== null && (
              <p className="text-[11px] italic leading-relaxed text-ink-soft">
                {SUBSTITUTE_COPY[v1.outcome.data.substitute]}
              </p>
            )}
            <p className="pt-0.5 text-[10px] text-ink-faint">
              {v1.outcome.data.category} · {v1.outcome.data.recognitionState}
            </p>
          </>
        )}
      </div>

      {/* The v2 column is the clickable one: it carries the trace, and this
          block REPLACES the standalone reply bubble rather than sitting under
          it, so the reply appears exactly once. */}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex cursor-pointer flex-col gap-1.5 bg-paper p-2.5 text-left"
      >
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          v2
          <span className="ml-1 normal-case tracking-normal text-ink-faint/80">
            {V2_PROMPT_VERSION}
          </span>
        </span>
        {v2Bubbles.length > 0 ? (
          <ColumnBubbles bubbles={v2Bubbles} tone="v2" />
        ) : (
          <p className="text-xs italic text-ink-faint">
            no reply was generated on this turn
          </p>
        )}
        {turn.response?.trace.gate?.verdict !== undefined &&
          turn.response.trace.gate.verdict !== 'send' && (
            <span className="text-[11px] italic text-ink-soft">
              gate: {turn.response.trace.gate.verdict}
            </span>
          )}
      </button>
    </div>
  )
}

/**
 * The one thing a reader must know before trusting a bubble-count difference:
 * v1's split coin is pinned to the no-split branch, so v1 can look like one
 * bubble where production would sometimes have sent two or three.
 */
export function V1ComparisonCaveat() {
  return (
    <p className="text-[11px] italic leading-relaxed text-ink-faint">
      v1 runs the real pipeline and sends nothing, but it does write its sandbox
      transcript to a synthetic guest - it builds context from the database. Its
      bubble split is pinned to the no-split branch, so where v1 shows one
      bubble production would sometimes have split it; a bubble-count difference
      here is not evidence on its own.
    </p>
  )
}
