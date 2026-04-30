// Standard health-status colors, used in Command Center / internal debug
// surfaces only. NOT brand tokens. Operator-facing surfaces (e.g. operator
// app) should use brand-aligned indicators instead.
//
// The brand rule from docs/brand/style-guide-v01.html — "no checkmarks or
// ✅" — still holds; we're using filled dots, just colored for fast
// at-a-glance status recognition rather than for editorial restraint.
//
// Tones:
//   - good     → green   (reachable, healthy, operational)
//   - neutral  → amber   (not-yet-configured, idle, partial)
//   - bad      → red     (failure, disconnected, broken)

interface StatusDotProps {
  tone: 'good' | 'neutral' | 'bad'
  /** Visually-hidden label for screen readers. */
  label: string
}

const COLOR: Record<StatusDotProps['tone'], string> = {
  good: '#16A34A',
  neutral: '#CA8A04',
  bad: '#DC2626',
}

export function StatusDot({ tone, label }: StatusDotProps) {
  return (
    <span
      className="inline-block size-2 rounded-full"
      style={{ backgroundColor: COLOR[tone] }}
      role="img"
      aria-label={label}
    />
  )
}
