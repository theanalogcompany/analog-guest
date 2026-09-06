'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Eyebrow } from '@/lib/ui'
import { type Transaction, TransactionRow } from './transaction-row'

// Full-width transactions section below the context cards. Card chrome
// reproduces the legacy trace look (bg-parchment + 6px radius via shadcn Card
// className overrides, TAC-306) so the bottom region reads as one visual
// cluster (Recognition → Pipeline → context cards → transactions, all on the
// same parchment surface).
//
// Header: count + window label · totals (sum + avg). Empty state: muted
// "no transactions in last N days" centered, no totals row.
//
// Window framing: defaults to 90 days to match the SQL window in
// page.tsx. Section header reflects the actual count, regardless of how
// the underlying data is distributed within that window.

interface TransactionsListProps {
  transactions: Transaction[]
  windowDays: number
  venueTimezone: string
  /** Operator's "now" — passed once per render so all rows compute the same relative dates. */
  now?: Date
}

export function TransactionsList({
  transactions,
  windowDays,
  venueTimezone,
  now: nowProp,
}: TransactionsListProps) {
  // Stable per-render "now" so all rows agree on relative dates.
  const now = useMemo(() => nowProp ?? new Date(), [nowProp])
  // TAC-323: after a successful delete, refresh so the server re-fetches the
  // transactions list — same router.refresh() propagation pattern as the
  // Voices command-center rail (server is source of truth, no client-side
  // removal state to keep in sync).
  const router = useRouter()

  if (transactions.length === 0) {
    return (
      <Card className="rounded-md border-stone-light/60 bg-parchment shadow-none p-3 flex flex-col gap-2">
        <header>
          <Eyebrow>{`Transactions · 0 in last ${windowDays} days`}</Eyebrow>
        </header>
        <div className="text-center text-sm text-ink-faint py-6">
          {`No transactions in the last ${windowDays} days.`}
        </div>
      </Card>
    )
  }

  // TAC-323: null-amount (guest-reported, unpriced) rows contribute 0 to the
  // sum — SUM()-ignores-NULL semantics, not a claim those orders cost $0 —
  // and don't count toward the average's denominator, so one unpriced order
  // doesn't silently drag the average down. See the per-row display in
  // transaction-row.tsx for the individual-row null case, which is handled
  // differently (shows "—", never folded into an average). When EVERY
  // transaction in the window is unpriced there's no known amount at all —
  // render that explicitly rather than a fabricated "$0.00 total · avg
  // $0.00" (mirrors page.tsx's avgPerVisitCents === null treatment).
  const pricedCount = transactions.reduce((acc, t) => (t.amountCents !== null ? acc + 1 : acc), 0)
  const totalCents = transactions.reduce((acc, t) => acc + (t.amountCents ?? 0), 0)
  const totalsLabel =
    pricedCount > 0
      ? `$${formatDollars(totalCents)} total · avg $${formatDollars(Math.round(totalCents / pricedCount))}`
      : 'amount unknown'

  return (
    <Card className="rounded-md border-stone-light/60 bg-parchment shadow-none p-3 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <Eyebrow>{`Transactions · ${transactions.length} in last ${windowDays} days`}</Eyebrow>
        <span className="text-xs text-ink-soft tabular-nums">{totalsLabel}</span>
      </header>
      <div className="flex flex-col">
        {transactions.map((tx) => (
          <TransactionRow
            key={tx.id}
            tx={tx}
            venueTimezone={venueTimezone}
            now={now}
            onDeleted={() => router.refresh()}
          />
        ))}
      </div>
    </Card>
  )
}

function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2)
}
