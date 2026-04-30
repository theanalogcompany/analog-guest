import type { HTMLAttributes } from 'react'

// Paper background, hairline border, 2px radius. Editorial restraint: no
// drop shadows, no elevation. For surfaces that need to read as a single
// content block within a parchment- or paper-toned shell.

export function Card({
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`bg-paper border border-stone-light/60 rounded-[2px] ${className}`}
    >
      {children}
    </div>
  )
}
