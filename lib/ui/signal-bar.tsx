// Single-bar visualization for a recognition signal. The bar fills relative
// to the signal's own per-signal max (its 0–100 normalized score), not the
// composite-score max. A signal performing at its ceiling fills the track
// regardless of how much weight it carries in the formula. Renders as a row:
//
//   [name 120px] [track flex-1] [value 40px right-aligned tabular]
//
// The right-aligned numeric shows the signal's score-point CONTRIBUTION
// (signal × weight), so operators can read both halves at once: the bar is
// "how this signal is doing on its own terms"; the number is "what those
// terms convert to in the score." Earlier versions of this component layered
// a faint weight bar behind the solid contribution bar — dropped because
// it left every solid bar looking under-filled even when the signal was
// near max.
//
// Presentational. No data fetching, no business logic. Lives in lib/ui/ so
// any future weight-vs-realized comparison surface can reuse it.

interface SignalBarProps {
  /** Signal label (e.g. "responseRate"). */
  name: string
  /**
   * Pre-multiplier 0–100 score for this signal. Drives the bar's fill width
   * as a percentage of the track. A signal at its own ceiling fills the
   * track regardless of how much weight it carries in the composite formula.
   */
  normalized: number
  /**
   * Realized score-point contribution (signal × weight). Drives the
   * right-aligned numeric value only — not the bar width. Lets operators
   * see "this signal is doing 92% of its job, contributing 23 points to
   * the score" without having to multiply in their head.
   */
  contribution: number
}

export function SignalBar({ name, normalized, contribution }: SignalBarProps) {
  const fillPct = clampPct(normalized)

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-[120px] shrink-0 text-ink-soft">{name}</span>
      <div className="flex-1 h-2 rounded-full bg-stone-light/60 relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-clay"
          style={{ width: `${fillPct}%` }}
          aria-hidden
        />
      </div>
      <span className="w-[40px] shrink-0 text-right tabular-nums text-ink">
        {Math.round(contribution)}
      </span>
    </div>
  )
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}
