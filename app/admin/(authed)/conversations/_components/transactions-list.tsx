'use client'

import { useMemo } from 'react'
import { Card, Eyebrow } from '@/lib/ui'
import { type Transaction, TransactionRow } from './transaction-row'

// Full-width transactions section below the context cards. Card chrome
// matches PR-4's resolution (variant="trace" — bg-parchment + 6px radius)
// so the bottom region reads as one visual cluster (Recognition → Pipeline
// → context cards → transactions, all on the same parchment surface).
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

  if (transactions.length === 0) {
    return (
      <Card variant="trace" className="p-3 flex flex-col gap-2">
        <header>
          <Eyebrow>{`Transactions · 0 in last ${windowDays} days`}</Eyebrow>
        </header>
        <div className="text-center text-sm text-ink-faint py-6">
          {`No transactions in the last ${windowDays} days.`}
        </div>
      </Card>
    )
  }

  const totalCents = transactions.reduce((acc, t) => acc + t.amountCents, 0)
  const avgCents = Math.round(totalCents / transactions.length)
  const totalsLabel = `$${formatDollars(totalCents)} total · avg $${formatDollars(avgCents)}`

  return (
    <Card variant="trace" className="p-3 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <Eyebrow>{`Transactions · ${transactions.length} in last ${windowDays} days`}</Eyebrow>
        <span className="text-xs text-ink-soft tabular-nums">{totalsLabel}</span>
      </header>
      <div className="flex flex-col">
        {transactions.map((tx) => (
          <TransactionRow key={tx.id} tx={tx} venueTimezone={venueTimezone} now={now} />
        ))}
      </div>
    </Card>
  )
}

function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2)
}
