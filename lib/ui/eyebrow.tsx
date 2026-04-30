import type { HTMLAttributes } from 'react'

// Uppercase 11px label with 0.22em tracking — the brand's primary
// section-introduction primitive. Default tone: ink-faint. Use 'clay' for
// accent eyebrows (rare; reserve for sections you want to draw the eye to).
// See docs/brand/style-guide-v01.html for usage.

interface EyebrowProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'faint' | 'clay'
}

export function Eyebrow({
  variant = 'faint',
  className = '',
  children,
  ...rest
}: EyebrowProps) {
  const tone = variant === 'clay' ? 'text-clay' : 'text-ink-faint'
  return (
    <span
      {...rest}
      className={`inline-block text-[11px] uppercase font-medium ${tone} ${className}`}
      style={{ letterSpacing: 'var(--tracking-eyebrow)' }}
    >
      {children}
    </span>
  )
}
