// Small filled dot — replaces ✅/❌/✓ across all admin surfaces. The brand
// rules in docs/brand/style-guide-v01.html prohibit emoji checkmarks; this
// is the canonical replacement.
//
// Tones:
//   - good     → clay (active, reachable, healthy)
//   - neutral  → stone (not-yet-configured, idle)
//   - bad      → clay-deep (failure, disconnected)

interface StatusDotProps {
  tone: 'good' | 'neutral' | 'bad'
  /** Visually-hidden label for screen readers. */
  label: string
}

export function StatusDot({ tone, label }: StatusDotProps) {
  const color =
    tone === 'good' ? 'bg-clay' : tone === 'bad' ? 'bg-clay-deep' : 'bg-stone'
  return (
    <span
      className={`inline-block size-2 rounded-full ${color}`}
      role="img"
      aria-label={label}
    />
  )
}
