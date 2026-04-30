import type { HTMLAttributes } from 'react'

// Row layout primitive with a 0.5px stone-light border below. Use to build
// table-like surfaces without card chrome — every receipt-shaped section in
// the brand uses this rhythm. The last row in a sequence should pass
// `last` to suppress the bottom border.

interface HairlineRowProps extends HTMLAttributes<HTMLDivElement> {
  /** Suppress the bottom border. Use on the last row of a sequence. */
  last?: boolean
}

export function HairlineRow({
  last = false,
  className = '',
  children,
  ...rest
}: HairlineRowProps) {
  const border = last ? '' : 'border-b border-stone-light/60'
  return (
    <div
      {...rest}
      className={`py-3 ${border} ${className}`}
    >
      {children}
    </div>
  )
}
