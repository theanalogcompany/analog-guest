// Stacked bar visualization for a single recognition signal. Two layered
// rectangles inside a faint stone-light track:
//   - Faint clay-soft bar = signal's allocated WEIGHT (0–1, scaled to track width)
//   - Solid clay fill     = signal's CONTRIBUTION (signal value × weight, also
//                            in the 0–100 scale, scaled to track width)
//
// When the solid bar fully fills the faint bar, the signal is performing at its
// allocated max. When the solid bar is much shorter than the faint bar, the
// signal has weight allocated but isn't earning it. Renders as a row:
//
//   [name 120px] [track flex-1] [value 40px right-aligned tabular]
//
// Presentational. No data fetching, no business logic. Lives in lib/ui/ because
// the same shape applies to mechanic eligibility weights and any other
// weight-vs-realized comparison.

interface SignalBarProps {
  /** Signal label (e.g. "responseRate"). */
  name: string
  /** Allocated weight, 0–1. Drives the faint bar's width as a percentage. */
  weight: number
  /**
   * Realized contribution in the 0–100 scale (where the per-signal max is
   * `weight × 100`). Drives the solid bar's width as a percentage and the
   * right-aligned numeric value.
   */
  contribution: number
}

export function SignalBar({ name, weight, contribution }: SignalBarProps) {
  const weightPct = clampPct(weight * 100)
  const contributionPct = clampPct(contribution)

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-[120px] shrink-0 text-ink-soft">{name}</span>
      <div className="flex-1 h-2 rounded-full bg-stone-light/60 relative overflow-hidden">
        {/* Allocated weight: faint clay layer */}
        <div
          className="absolute inset-y-0 left-0 bg-clay-soft"
          style={{ width: `${weightPct}%` }}
          aria-hidden
        />
        {/* Realized contribution: solid clay layer on top */}
        <div
          className="absolute inset-y-0 left-0 bg-clay"
          style={{ width: `${contributionPct}%` }}
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
