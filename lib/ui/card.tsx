import type { HTMLAttributes } from 'react'

// Two visual surfaces:
//
//   - default — paper background, 2px radius. Editorial restraint. The
//     receipt-shaped surface used across most admin pages (health, recent-
//     activity, inbound-detail).
//   - trace   — parchment background, 6px radius. Bespoke chrome for the
//     conversations trace family (Recognition / Pipeline / context cards).
//     Slightly warmer + softer; reads as a related cluster on the page.
//
// Both share the same hairline border. No drop shadows, no elevation.
// Padding is the caller's responsibility — Card has none by default so
// row-based content (HairlineRow) and freeform content (KvList) coexist
// without forcing one assumption on the other.

type CardVariant = 'default' | 'trace'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant
}

const VARIANT_CLASSES: Record<CardVariant, string> = {
  default: 'bg-paper rounded-[2px]',
  trace: 'bg-parchment rounded-md',
}

export function Card({
  variant = 'default',
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      {...rest}
      className={`${VARIANT_CLASSES[variant]} border border-stone-light/60 ${className}`}
    >
      {children}
    </div>
  )
}
