import type { ReactNode } from 'react'

// Title + optional subtitle, baseline-aligned, with a hairline border below.
// Title uses Fraunces with the brand-default opsz/SOFT/WONK variation
// settings. Subtitle is Inter Tight, ink-soft, baseline-aligned to the
// right of the title.

interface SectionHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  /** Optional eyebrow rendered above the title. */
  eyebrow?: ReactNode
}

export function SectionHeader({ title, subtitle, eyebrow }: SectionHeaderProps) {
  return (
    <header className="flex flex-col gap-2 pb-4 border-b border-stone-light/60">
      {eyebrow ? <div>{eyebrow}</div> : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2
          className="font-fraunces text-3xl text-ink leading-[1.1]"
          style={{ fontVariationSettings: 'var(--fraunces)' }}
        >
          {title}
        </h2>
        {subtitle ? (
          <p className="text-sm text-ink-soft leading-snug">{subtitle}</p>
        ) : null}
      </div>
    </header>
  )
}
