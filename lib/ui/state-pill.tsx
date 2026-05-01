// Compact clay-tinted pill for displaying a guest's recognition state
// ('new', 'returning', 'regular', 'raving_fan'). Used in the recognition
// card header and on the guest context card (PR-4 will switch over).
//
// Tone: clay-soft background + clay-deep text. Per the THE-201 decision,
// recognition states are not "wrong" — `new` is neutral, the others are
// good — so we don't gate the pill behind `tone`. All states use the same
// clay tint; the *label* communicates the state.

interface StatePillProps {
  /** Recognition state value, e.g. "regular". Rendered as-is. */
  state: string
}

export function StatePill({ state }: StatePillProps) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-clay-soft/50 text-clay-deep tabular-nums">
      {state}
    </span>
  )
}
