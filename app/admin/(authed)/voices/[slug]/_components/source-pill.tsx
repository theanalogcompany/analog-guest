// Compact 9.5px uppercase pill rendered next to anti-pattern + corpus rows
// to communicate provenance. Three variants:
//   - manual:    operator typed it (stone-light bg)
//   - auto:      promoted from a critique cluster (clay tinted)
//   - universal: locked R-rule (ink bg, paper text)

interface SourcePillProps {
  variant: 'manual' | 'auto' | 'universal'
  children: React.ReactNode
}

const TONE: Record<SourcePillProps['variant'], string> = {
  manual: 'bg-stone-light text-ink-soft',
  auto: 'bg-clay-soft/30 text-clay-deep',
  universal: 'bg-ink text-paper',
}

export function SourcePill({ variant, children }: SourcePillProps) {
  return (
    <span
      className={`inline-block px-1.5 py-[2px] rounded-[2px] text-[9.5px] font-semibold ${TONE[variant]}`}
      style={{ letterSpacing: '0.05em' }}
    >
      {children}
    </span>
  )
}
