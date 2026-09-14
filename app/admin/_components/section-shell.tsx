import type { ReactNode } from 'react'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Shared card chrome for Command Center sections. Originally the venue page's
// own wrapper (TAC-343 Stage A); promoted here in TAC-381 because the
// intentions page (TAC-379) had grown an identical local `Section` and the
// venue commitments/intentions sections would have made a third copy.
//
// `headerAction` (TAC-343 Stage C) is the Edit/Add toggle a writable section
// renders in the header row, via shadcn Card's own action slot. Read-only
// sections omit it.
//
// One deliberate reconciliation at promotion time: the intentions page's copy
// used `CardContent py-5` where the venue page's used `py-4`. Unified on
// `py-4`, the value 14 of the 15 call sites already rendered.

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
