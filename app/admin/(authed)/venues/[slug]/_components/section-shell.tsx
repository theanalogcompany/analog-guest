import type { ReactNode } from 'react'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Shared card chrome for every §2 section on the venue page (TAC-343 Stage
// A). Keeps every section visually consistent without 12 near-identical
// wrapper divs. `headerAction` (Stage C) is the Edit/Add toggle a writable
// section renders in the header row, via shadcn Card's own action slot.

export function SectionShell({
  title,
  subtitle,
  headerAction,
  children,
}: {
  title: string
  subtitle?: string
  headerAction?: ReactNode
  children: ReactNode
}) {
  return (
    <Card className="block gap-0 rounded-[2px] border-stone-light/60 bg-paper py-0 shadow-none">
      <CardHeader className="border-b border-stone-light/60 py-4">
        <CardTitle className="font-fraunces text-lg text-ink">{title}</CardTitle>
        {subtitle && <p className="text-xs text-ink-faint">{subtitle}</p>}
        {headerAction && <CardAction>{headerAction}</CardAction>}
      </CardHeader>
      <CardContent className="py-4">{children}</CardContent>
    </Card>
  )
}

export function EmptySectionNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-faint italic">{children}</p>
}
